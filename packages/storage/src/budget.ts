/**
 * Atomic budget service (CORE-05). Enforces the token discipline from
 * AGENTS.md: budgets are reserved atomically in usage_ledger BEFORE any
 * external call, settled with actual usage after, and daily caps hold even
 * on free tiers.
 *
 * Ledger semantics: an open reservation holds its reserved maxima against
 * the owner's daily caps; the matching settlement (written atomically with
 * the reservation's flip to 'settled') holds the actual usage instead — so
 * caps never double-count. Expired reservations hold nothing. Overruns are
 * reported via the contracts' reconcile(), never hidden.
 *
 * All statements run inside a write transaction so check-then-insert is
 * atomic under libSQL's single-writer model.
 */
import { randomUUID } from "node:crypto";
import type { Client, Row, Transaction } from "@libsql/client";
import {
  planReservation,
  reconcile,
  type BudgetRequest,
  type BudgetReservation,
} from "@do-sift/contracts";

export interface DailyCaps {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSearchCalls: number;
  maxFetches: number;
}

export type BudgetFailureKind = "cap-exceeded" | "unknown-reservation" | "reservation-not-open";

export class BudgetServiceError extends Error {
  constructor(
    public readonly kind: BudgetFailureKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "BudgetServiceError";
  }
}

export interface ReserveInput {
  ownerId: string;
  requestId?: string | undefined;
  request: BudgetRequest;
  estimatedInputTokens: number;
  nowMs: number;
}

export interface SettleInput {
  ownerId: string;
  reservationId: string;
  actual: { inputTokens: number; outputTokens: number; searchCalls?: number; fetches?: number };
  nowMs: number;
}

export interface SettleResult {
  settlementId: string;
  overrun: boolean;
  deltaInput: number;
  deltaOutput: number;
}

export interface HeldUsage {
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  fetches: number;
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Usage held against caps: open reservation maxima + settled actuals. */
async function heldUsage(tx: Transaction, ownerId: string, day: string): Promise<HeldUsage> {
  const res = await tx.execute({
    sql: `SELECT COALESCE(SUM(input_tokens), 0) AS i,
                 COALESCE(SUM(output_tokens), 0) AS o,
                 COALESCE(SUM(search_calls), 0) AS s,
                 COALESCE(SUM(fetches), 0) AS f
          FROM usage_ledger
          WHERE owner_id = ? AND day = ?
            AND ((kind = 'reservation' AND state = 'open')
              OR (kind = 'settlement' AND state = 'settled'))`,
    args: [ownerId, day],
  });
  const row = res.rows[0];
  return {
    inputTokens: Number(row?.i ?? 0),
    outputTokens: Number(row?.o ?? 0),
    searchCalls: Number(row?.s ?? 0),
    fetches: Number(row?.f ?? 0),
  };
}

function reservationRow(row: Row): {
  id: string;
  day: string;
  state: string;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  fetches: number;
  expiresAtMs: number;
} {
  return {
    id: String(row.id),
    day: String(row.day),
    state: String(row.state),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    searchCalls: Number(row.search_calls),
    fetches: Number(row.fetches),
    // pre-0003 rows have no deadline; 0 never reads as "in the future"
    expiresAtMs:
      row.expires_at === null || row.expires_at === undefined
        ? 0
        : Date.parse(String(row.expires_at)),
  };
}

export class BudgetService {
  constructor(
    private readonly client: Client,
    private readonly caps: DailyCaps,
  ) {}

  /**
   * Atomically reserve budget. Throws the contracts' estimate-exceeds-budget
   * error before touching the ledger, and BudgetServiceError('cap-exceeded')
   * when the reservation would exceed the owner's daily caps. Open
   * reservations hold their maxima until settled or expired.
   */
  async reserve(input: ReserveInput): Promise<{ id: string; reservation: BudgetReservation }> {
    const reservation = planReservation(input.request, input.estimatedInputTokens, input.nowMs);
    const day = utcDay(input.nowMs);
    const expiresAt = new Date(reservation.expiresAtMs).toISOString();

    const tx = await this.client.transaction("write");
    try {
      const held = await heldUsage(tx, input.ownerId, day);
      if (held.inputTokens + reservation.inputTokens > this.caps.maxInputTokens) {
        throw new BudgetServiceError(
          "cap-exceeded",
          `owner ${input.ownerId}: input ${held.inputTokens} held + ${reservation.inputTokens} reserved > daily cap ${this.caps.maxInputTokens}`,
        );
      }
      if (held.outputTokens + reservation.outputTokens > this.caps.maxOutputTokens) {
        throw new BudgetServiceError(
          "cap-exceeded",
          `owner ${input.ownerId}: output ${held.outputTokens} held + ${reservation.outputTokens} reserved > daily cap ${this.caps.maxOutputTokens}`,
        );
      }
      if (held.searchCalls + reservation.searchCalls > this.caps.maxSearchCalls) {
        throw new BudgetServiceError(
          "cap-exceeded",
          `owner ${input.ownerId}: search calls ${held.searchCalls} held + ${reservation.searchCalls} reserved > daily cap ${this.caps.maxSearchCalls}`,
        );
      }
      if (held.fetches + reservation.fetches > this.caps.maxFetches) {
        throw new BudgetServiceError(
          "cap-exceeded",
          `owner ${input.ownerId}: fetches ${held.fetches} held + ${reservation.fetches} reserved > daily cap ${this.caps.maxFetches}`,
        );
      }

      const id = randomUUID();
      await tx.execute({
        sql: `INSERT INTO usage_ledger (id, owner_id, request_id, kind, input_tokens, output_tokens,
               search_calls, fetches, day, state, expires_at, created_at)
              VALUES (?, ?, ?, 'reservation', ?, ?, ?, ?, ?, 'open', ?, ?)`,
        args: [
          id,
          input.ownerId,
          input.requestId ?? null,
          reservation.inputTokens,
          reservation.outputTokens,
          reservation.searchCalls,
          reservation.fetches,
          day,
          expiresAt,
          new Date(input.nowMs).toISOString(),
        ],
      });
      await tx.commit();
      return { id, reservation };
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  /**
   * Settle an open reservation with actual usage: writes the settlement row
   * and flips the reservation to 'settled' in one transaction. Actual usage
   * above the reservation is recorded honestly and reported as an overrun —
   * it never blocks the write.
   */
  async settle(input: SettleInput): Promise<SettleResult> {
    const tx = await this.client.transaction("write");
    try {
      const res = await tx.execute({
        sql: "SELECT id, day, state, input_tokens, output_tokens, search_calls, fetches, expires_at FROM usage_ledger WHERE id = ? AND owner_id = ? AND kind = 'reservation'",
        args: [input.reservationId, input.ownerId],
      });
      const row = res.rows[0];
      if (!row) {
        throw new BudgetServiceError(
          "unknown-reservation",
          `no reservation ${input.reservationId} for owner ${input.ownerId}`,
        );
      }
      const reservation = reservationRow(row);
      if (reservation.state !== "open") {
        throw new BudgetServiceError(
          "reservation-not-open",
          `reservation ${input.reservationId} is ${reservation.state}, not open`,
        );
      }

      const settlementId = randomUUID();
      await tx.execute({
        sql: `INSERT INTO usage_ledger (id, owner_id, request_id, kind, input_tokens, output_tokens,
               search_calls, fetches, day, state, expires_at, created_at)
              VALUES (?, ?, (SELECT request_id FROM usage_ledger WHERE id = ?), 'settlement',
                      ?, ?, ?, ?, ?, 'settled', NULL, ?)`,
        args: [
          settlementId,
          input.ownerId,
          input.reservationId,
          input.actual.inputTokens,
          input.actual.outputTokens,
          input.actual.searchCalls ?? 0,
          input.actual.fetches ?? 0,
          reservation.day,
          new Date(input.nowMs).toISOString(),
        ],
      });
      await tx.execute({
        sql: "UPDATE usage_ledger SET state = 'settled' WHERE id = ? AND owner_id = ?",
        args: [input.reservationId, input.ownerId],
      });
      await tx.commit();

      const rec = reconcile(reservation, {
        inputTokens: input.actual.inputTokens,
        outputTokens: input.actual.outputTokens,
      });
      return {
        settlementId,
        overrun: rec.overrun,
        deltaInput: rec.deltaInput,
        deltaOutput: rec.deltaOutput,
      };
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  /**
   * Mark this owner's overdue open reservations 'expired' (deadline passed).
   * Expired reservations stop holding cap budget. Returns how many expired.
   */
  async expireDue(ownerId: string, nowMs: number): Promise<number> {
    const tx = await this.client.transaction("write");
    try {
      const res = await tx.execute({
        sql: `UPDATE usage_ledger SET state = 'expired'
              WHERE owner_id = ? AND kind = 'reservation' AND state = 'open'
                AND expires_at IS NOT NULL AND expires_at < ?`,
        args: [ownerId, new Date(nowMs).toISOString()],
      });
      await tx.commit();
      return res.rowsAffected;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  /** Inspect held usage for an owner on a UTC day (reporting/diagnostics). */
  async heldForDay(ownerId: string, nowMs: number): Promise<HeldUsage> {
    const tx = await this.client.transaction("read");
    try {
      const held = await heldUsage(tx, ownerId, utcDay(nowMs));
      await tx.commit();
      return held;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }
}
