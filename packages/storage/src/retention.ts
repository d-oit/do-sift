/**
 * Owner-scoped retention (#64). Prunes only rows that can no longer affect
 * behaviour: terminal jobs (`done`/`dead`) and closed usage rows
 * (`settled`/`expired`) older than the cutoff. Open reservations, queued or
 * leased jobs, and evidence (documents, passages, answers) are never touched.
 * Callers pass a cutoff at or before the start of the current UTC day so
 * daily cap accounting for today is never lost.
 */
import type { Client } from "@libsql/client";

export interface RetentionResult {
  jobsDeleted: number;
  usageDeleted: number;
}

export interface RetentionCandidates {
  jobsCandidateCount: number;
  usageCandidateCount: number;
}

export interface RetentionReceipt extends RetentionResult {
  ownerId: string;
  cutoffIso: string;
  dryRun: boolean;
  jobsCandidateCount: number;
  jobsDeletedCount: number;
  usageCandidateCount: number;
  usageDeletedCount: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface PruneOwnerHistoryOptions {
  dryRun?: boolean;
  now?: Date;
}

export function getStartOfUtcDay(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function calculateRetentionCutoff(retentionDays: number, now: Date = new Date()): string {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(
      `calculateRetentionCutoff: retentionDays must be an integer >= 1 (got ${retentionDays})`,
    );
  }
  const startOfToday = getStartOfUtcDay(now);
  const cutoff = new Date(startOfToday.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  return cutoff.toISOString();
}

export function validateRetentionCutoff(beforeIso: string, now: Date = new Date()): void {
  const cutoffMs = Date.parse(beforeIso);
  if (Number.isNaN(cutoffMs)) {
    throw new Error(`pruneOwnerHistory: cutoff is not a valid ISO timestamp (${beforeIso})`);
  }
  const startOfTodayMs = getStartOfUtcDay(now).getTime();
  if (cutoffMs > startOfTodayMs) {
    throw new Error(
      `pruneOwnerHistory: cutoff (${beforeIso}) must be at or before start of current UTC day (${getStartOfUtcDay(now).toISOString()}) to preserve current-day usage accounting`,
    );
  }
}

export async function evaluateOwnerRetention(
  client: Client,
  ownerId: string,
  beforeIso: string,
  now?: Date,
): Promise<RetentionCandidates> {
  validateRetentionCutoff(beforeIso, now);
  const jobsRes = await client.execute({
    sql: "SELECT COUNT(*) AS count FROM jobs WHERE owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
    args: [ownerId, beforeIso],
  });
  const usageRes = await client.execute({
    sql: "SELECT COUNT(*) AS count FROM usage_ledger WHERE owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
    args: [ownerId, beforeIso],
  });

  const jobsCount = Number(jobsRes.rows[0]?.["count"] ?? 0);
  const usageCount = Number(usageRes.rows[0]?.["count"] ?? 0);

  return {
    jobsCandidateCount: jobsCount,
    usageCandidateCount: usageCount,
  };
}

export async function pruneOwnerHistory(
  client: Client,
  ownerId: string,
  beforeIso: string,
  options: PruneOwnerHistoryOptions = {},
): Promise<RetentionReceipt> {
  const startTime = Date.now();
  const dryRun = options.dryRun ?? false;

  validateRetentionCutoff(beforeIso, options.now);

  const candidates = await evaluateOwnerRetention(client, ownerId, beforeIso, options.now);

  if (dryRun) {
    return {
      ownerId,
      cutoffIso: beforeIso,
      dryRun: true,
      jobsCandidateCount: candidates.jobsCandidateCount,
      jobsDeletedCount: 0,
      usageCandidateCount: candidates.usageCandidateCount,
      usageDeletedCount: 0,
      jobsDeleted: 0,
      usageDeleted: 0,
      durationMs: Date.now() - startTime,
      success: true,
    };
  }

  const tx = await client.transaction("write");
  try {
    const jobsRes = await tx.execute({
      sql: "DELETE FROM jobs WHERE owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
      args: [ownerId, beforeIso],
    });
    const usageRes = await tx.execute({
      sql: "DELETE FROM usage_ledger WHERE owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
      args: [ownerId, beforeIso],
    });
    await tx.commit();

    const jobsDeletedCount = Number(jobsRes.rowsAffected);
    const usageDeletedCount = Number(usageRes.rowsAffected);

    return {
      ownerId,
      cutoffIso: beforeIso,
      dryRun: false,
      jobsCandidateCount: candidates.jobsCandidateCount,
      jobsDeletedCount,
      usageCandidateCount: candidates.usageCandidateCount,
      usageDeletedCount,
      jobsDeleted: jobsDeletedCount,
      usageDeleted: usageDeletedCount,
      durationMs: Date.now() - startTime,
      success: true,
    };
  } catch (error) {
    await tx.rollback().catch(() => {});
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      ownerId,
      cutoffIso: beforeIso,
      dryRun: false,
      jobsCandidateCount: candidates.jobsCandidateCount,
      jobsDeletedCount: 0,
      usageCandidateCount: candidates.usageCandidateCount,
      usageDeletedCount: 0,
      jobsDeleted: 0,
      usageDeleted: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: errMessage,
    };
  }
}

export interface ScheduledRetentionRunnerOptions {
  client: Client;
  owners: string[];
  retentionDays: number;
  intervalMs: number;
  onReceipt?: (receipt: RetentionReceipt) => void;
  onError?: (ownerId: string, error: unknown) => void;
  now?: () => Date;
}

export class ScheduledRetentionRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: ScheduledRetentionRunnerOptions) {
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new Error(
        `ScheduledRetentionRunner: retentionDays must be an integer >= 1 (got ${options.retentionDays})`,
      );
    }
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 60000) {
      throw new Error(
        `ScheduledRetentionRunner: intervalMs must be an integer >= 60000 (got ${options.intervalMs})`,
      );
    }
  }

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.options.intervalMs);
    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async runOnce(): Promise<RetentionReceipt[]> {
    if (this.running) return [];
    this.running = true;
    const receipts: RetentionReceipt[] = [];
    try {
      const now = this.options.now ? this.options.now() : new Date();
      const cutoffIso = calculateRetentionCutoff(this.options.retentionDays, now);
      for (const ownerId of this.options.owners) {
        try {
          const receipt = await pruneOwnerHistory(this.options.client, ownerId, cutoffIso, {
            dryRun: false,
            now,
          });
          receipts.push(receipt);
          if (this.options.onReceipt) {
            this.options.onReceipt(receipt);
          }
        } catch (err) {
          if (this.options.onError) {
            this.options.onError(ownerId, err);
          }
        }
      }
    } finally {
      this.running = false;
    }
    return receipts;
  }
}
