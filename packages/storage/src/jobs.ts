/**
 * Durable job queue (CORE-07) over the jobs table from migration 0002.
 *
 * Semantics: FIFO per owner; a lease marks a job 'leased' with a deadline —
 * a crashed worker's lease expires and the job is reclaimed by a later
 * leaseNext (attempts keep counting). fail() requeues until maxAttempts,
 * then dead-letters with the last error. Every operation is owner-scoped
 * and takes an explicit nowMs so tests are deterministic.
 *
 * The queue is storage, not execution: it never runs jobs, and it never
 * grants capabilities — runners (SRC/BRW) claim work and answer for it.
 */
import { randomUUID } from "node:crypto";
import type { Client, Row } from "@libsql/client";

export interface JobQueueOptions {
  /** Lease attempts before dead-lettering; default 3. */
  maxAttempts?: number | undefined;
  /** Lease duration in ms; default 60_000. */
  leaseMs?: number | undefined;
}

const DEFAULTS = { maxAttempts: 3, leaseMs: 60_000 };

export type JobStatus = "queued" | "leased" | "done" | "dead";

export interface JobRecord {
  id: string;
  ownerId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  leaseUntil?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export class JobQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobQueueError";
  }
}

function jobFromRow(row: Row): JobRecord {
  const leaseUntil =
    row.lease_until === null || row.lease_until === undefined ? undefined : String(row.lease_until);
  const lastError =
    row.last_error === null || row.last_error === undefined ? undefined : String(row.last_error);
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    kind: String(row.kind),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    status: String(row.status) as JobStatus,
    attempts: Number(row.attempts),
    leaseUntil,
    lastError,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class JobQueue {
  constructor(
    private readonly client: Client,
    private readonly options: JobQueueOptions = {},
  ) {}

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? DEFAULTS.maxAttempts;
  }

  private get leaseMs(): number {
    return this.options.leaseMs ?? DEFAULTS.leaseMs;
  }

  async enqueue(
    ownerId: string,
    kind: string,
    payload: Record<string, unknown>,
    nowMs: number,
  ): Promise<string> {
    const id = randomUUID();
    await this.client.execute({
      sql: "INSERT INTO jobs (id, owner_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
      args: [id, ownerId, kind, JSON.stringify(payload), iso(nowMs), iso(nowMs)],
    });
    return id;
  }

  /**
   * Claim the oldest runnable job for this owner: 'queued', or 'leased'
   * whose lease has expired (crash recovery). Runs claim + bookkeeping in
   * one write transaction; concurrent claimants can never both win.
   */
  async leaseNext(ownerId: string, nowMs: number): Promise<JobRecord | undefined> {
    const tx = await this.client.transaction("write");
    try {
      const now = iso(nowMs);
      const candidate = await tx.execute({
        sql: `SELECT id FROM jobs
              WHERE owner_id = ?
                AND (status = 'queued'
                  OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?))
              ORDER BY created_at
              LIMIT 1`,
        args: [ownerId, now],
      });
      const id = candidate.rows[0] ? String(candidate.rows[0].id) : undefined;
      if (id === undefined) {
        await tx.commit();
        return undefined;
      }
      const claimed = await tx.execute({
        sql: `UPDATE jobs SET status = 'leased', attempts = attempts + 1, lease_until = ?, updated_at = ?
              WHERE id = ? AND owner_id = ?
                AND (status = 'queued'
                  OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?))`,
        args: [iso(nowMs + this.leaseMs), now, id, ownerId, now],
      });
      if (claimed.rowsAffected === 0) {
        await tx.commit();
        return undefined;
      }
      const fresh = await tx.execute({
        sql: "SELECT * FROM jobs WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      await tx.commit();
      const row = fresh.rows[0];
      return row ? jobFromRow(row) : undefined;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  /** Mark a leased (or queued) job done. Refuses unknown/foreign jobs. */
  async complete(ownerId: string, id: string, nowMs: number): Promise<void> {
    const res = await this.client.execute({
      sql: `UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = ?
            WHERE id = ? AND owner_id = ? AND status IN ('queued', 'leased')`,
      args: [iso(nowMs), id, ownerId],
    });
    if (res.rowsAffected === 0) {
      throw new JobQueueError(`job ${id} is not completable for owner ${ownerId}`);
    }
  }

  /**
   * Report a failed attempt. Requeues with the error recorded while
   * attempts remain; dead-letters otherwise. Returns the outcome.
   */
  async fail(
    ownerId: string,
    id: string,
    errorMessage: string,
    nowMs: number,
  ): Promise<"requeued" | "dead"> {
    const tx = await this.client.transaction("write");
    try {
      const current = await tx.execute({
        sql: "SELECT status, attempts FROM jobs WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      const row = current.rows[0];
      if (!row) throw new JobQueueError(`unknown job ${id} for owner ${ownerId}`);
      const status = String(row.status);
      if (status !== "queued" && status !== "leased") {
        throw new JobQueueError(`job ${id} is ${status}; only queued/leased jobs can fail`);
      }
      const attempts = Number(row.attempts);
      const dead = attempts >= this.maxAttempts;
      await tx.execute({
        sql: `UPDATE jobs SET status = ?, lease_until = NULL, last_error = ?, updated_at = ?
              WHERE id = ? AND owner_id = ?`,
        args: [dead ? "dead" : "queued", errorMessage, iso(nowMs), id, ownerId],
      });
      await tx.commit();
      return dead ? "dead" : "requeued";
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  async get(ownerId: string, id: string): Promise<JobRecord | undefined> {
    const res = await this.client.execute({
      sql: "SELECT * FROM jobs WHERE id = ? AND owner_id = ?",
      args: [id, ownerId],
    });
    const row = res.rows[0];
    return row ? jobFromRow(row) : undefined;
  }
}
