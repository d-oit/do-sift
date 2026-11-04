/**
 * Synthesis call log (issue #123, plan 038 — EXT-03).
 *
 * One row per billable synthesis call: provider, model, actual usage, the
 * verified price it was computed at, and the resulting cost. This is the
 * audit trail `usage_ledger` deliberately is not — see migration 0013.
 *
 * Money is stored as integer micro-USD (1e-6 USD). Cost is derived from the
 * price metadata the router verified, so a price change appends a new price
 * revision to history instead of rewriting past costs.
 *
 * Writes are tenant-scoped from the bound handle and best-effort at the call
 * site: a logging failure must never lose an answer that was already produced
 * and settled.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { DEFAULT_TENANT_ID } from "@do-sift/contracts";

/** Failure classes a synthesis call can record. */
export const SYNTHESIS_FAILURE_KINDS = [
  "rate-limited",
  "timeout",
  "http",
  "aborted",
  "unknown",
] as const;
export type SynthesisFailureKind = (typeof SYNTHESIS_FAILURE_KINDS)[number];

/** One recorded synthesis call. */
export interface SynthesisCallLog {
  tenantId: string;
  ownerId: string;
  /** The research/answer request row, when the call belongs to one. */
  requestId?: string | undefined;
  /** The stored answer, when the call produced one. */
  answerId?: string | undefined;
  /** Contract identity of the model provider that ran (router entry name). */
  provider: string;
  /** Model id the provider reports (may differ from the router entry name). */
  model: string;
  /** True when token counts were estimated locally rather than reported. */
  estimated: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Verified price per 1M tokens, in micro-USD. */
  priceInputPer1mMicroUsd: number;
  priceOutputPer1mMicroUsd: number;
  outcome: "completed" | "failed";
  failureKind?: SynthesisFailureKind | undefined;
  /** ISO timestamp; defaults to now. */
  at?: string | undefined;
}

/** A logged call as read back. */
export interface SynthesisCallRow {
  id: string;
  provider: string;
  model: string;
  estimated: boolean;
  inputTokens: number;
  outputTokens: number;
  totalCostMicroUsd: number;
  outcome: "completed" | "failed";
  failureKind?: SynthesisFailureKind | undefined;
  createdAt: string;
}

/** Cost of one call at a verified price, in micro-USD (rounded up: never under-report). */
export function synthesisCostMicroUsd(
  inputTokens: number,
  outputTokens: number,
  priceInputPer1mMicroUsd: number,
  priceOutputPer1mMicroUsd: number,
): { inputCostMicroUsd: number; outputCostMicroUsd: number; totalCostMicroUsd: number } {
  const inputCostMicroUsd = Math.ceil((inputTokens * priceInputPer1mMicroUsd) / 1_000_000);
  const outputCostMicroUsd = Math.ceil((outputTokens * priceOutputPer1mMicroUsd) / 1_000_000);
  return {
    inputCostMicroUsd,
    outputCostMicroUsd,
    totalCostMicroUsd: inputCostMicroUsd + outputCostMicroUsd,
  };
}

function utcDay(at: string): string {
  return at.slice(0, 10);
}

export class SynthesisCallLogService {
  /** Tenant this log is bound to; never caller-supplied per write. */
  readonly tenantId: string;

  constructor(
    private readonly client: Client,
    tenantId: string = DEFAULT_TENANT_ID,
  ) {
    if (tenantId.trim() === "") throw new Error("SynthesisCallLogService needs a non-empty tenant");
    this.tenantId = tenantId;
  }

  /** Append one call record and return its id. */
  async record(entry: SynthesisCallLog): Promise<string> {
    if (entry.ownerId.trim() === "") throw new Error("synthesis log needs a non-empty owner id");
    if (entry.provider.trim() === "") throw new Error("synthesis log needs a provider name");
    if (entry.provider !== entry.provider.trim()) {
      throw new Error("provider name must not have surrounding whitespace");
    }
    if (entry.inputTokens < 0 || entry.outputTokens < 0) {
      throw new Error("synthesis log token counts must not be negative");
    }
    const at = entry.at ?? new Date().toISOString();
    const cost = synthesisCostMicroUsd(
      entry.inputTokens,
      entry.outputTokens,
      entry.priceInputPer1mMicroUsd,
      entry.priceOutputPer1mMicroUsd,
    );
    const id = randomUUID();
    await this.client.execute({
      sql: `INSERT INTO synthesis_calls (
              id, tenant_id, owner_id, request_id, answer_id, provider, model, estimated,
              input_tokens, output_tokens, input_cost_micro_usd, output_cost_micro_usd,
              total_cost_micro_usd, price_input_per_1m_micro_usd, price_output_per_1m_micro_usd,
              outcome, failure_kind, created_at, created_day
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        this.tenantId,
        entry.ownerId,
        entry.requestId ?? null,
        entry.answerId ?? null,
        entry.provider,
        entry.model,
        entry.estimated ? 1 : 0,
        entry.inputTokens,
        entry.outputTokens,
        cost.inputCostMicroUsd,
        cost.outputCostMicroUsd,
        cost.totalCostMicroUsd,
        entry.priceInputPer1mMicroUsd,
        entry.priceOutputPer1mMicroUsd,
        entry.outcome,
        entry.failureKind ?? null,
        at,
        utcDay(at),
      ],
    });
    return id;
  }

  /** Newest-first calls for one owner inside the bound tenant. */
  async list(ownerId: string, limit = 50): Promise<SynthesisCallRow[]> {
    const res = await this.client.execute({
      sql: `SELECT id, provider, model, estimated, input_tokens, output_tokens,
                   total_cost_micro_usd, outcome, failure_kind, created_at
            FROM synthesis_calls
            WHERE tenant_id = ? AND owner_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
      args: [this.tenantId, ownerId, limit],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      model: String(row.model),
      estimated: Number(row.estimated) === 1,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalCostMicroUsd: Number(row.total_cost_micro_usd),
      outcome: String(row.outcome) === "failed" ? "failed" : "completed",
      ...(row.failure_kind === null || row.failure_kind === undefined
        ? {}
        : { failureKind: String(row.failure_kind) as SynthesisFailureKind }),
      createdAt: String(row.created_at),
    }));
  }

  /** Sum of recorded call cost for one owner and UTC day, in micro-USD. */
  async totalCostMicroUsdForDay(ownerId: string, day: string): Promise<number> {
    const res = await this.client.execute({
      sql: `SELECT COALESCE(SUM(total_cost_micro_usd), 0) AS total
            FROM synthesis_calls
            WHERE tenant_id = ? AND owner_id = ? AND created_day = ?`,
      args: [this.tenantId, ownerId, day],
    });
    return Number(res.rows[0]?.total ?? 0);
  }
}
