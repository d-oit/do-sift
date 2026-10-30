/**
 * Owner-scoped retention (#64). Prunes only rows that can no longer affect
 * behaviour: terminal jobs (`done`/`dead`) and closed usage rows
 * (`settled`/`expired`) older than the cutoff. Open reservations, queued or
 * leased jobs, and evidence (documents, passages, answers) are never touched.
 * Callers pass a cutoff at or before the start of the current UTC day so
 * daily cap accounting for today is never lost.
 */
import type { Client } from "@libsql/client";

export interface RetentionConfig {
  /**
   * Whether scheduled or automated retention is enabled.
   * Defaults to false (never-delete/disabled unless explicit).
   */
  enabled: boolean;
  /**
   * Number of days of history to retain.
   */
  retentionDays?: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  enabled: false,
};

export interface RetentionResult {
  jobsDeleted: number;
  usageDeleted: number;
}

export interface RetentionReceipt {
  ownerId: string;
  cutoff: string;
  dryRun: boolean;
  candidates: {
    terminalJobs: number;
    closedUsage: number;
  };
  deleted: {
    terminalJobs: number;
    closedUsage: number;
  };
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface RetentionOptions {
  ownerId: string;
  /** Explicit cutoff ISO timestamp. */
  beforeIso?: string | undefined;
  /** Number of days of history to retain relative to current UTC day start. */
  retentionDays?: number | undefined;
  /** If true, calculates candidate counts without deleting rows. */
  dryRun?: boolean | undefined;
  /** Reference time for calculating current UTC day start (defaults to new Date()). */
  now?: Date | undefined;
}

export function calculateStartOfTodayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

export function calculateSafeCutoff(retentionDays: number, now: Date = new Date()): string {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`retentionDays must be a positive integer (got ${retentionDays})`);
  }
  const startOfToday = calculateStartOfTodayUtc(now);
  const cutoff = new Date(startOfToday.getTime() - retentionDays * 86_400_000);
  return cutoff.toISOString();
}

export function validateCutoffIso(beforeIso: string, now: Date = new Date()): string {
  const parsed = Date.parse(beforeIso);
  if (Number.isNaN(parsed)) {
    throw new Error(`cutoff is not a valid ISO timestamp (${beforeIso})`);
  }
  const cutoffDate = new Date(parsed);
  const startOfToday = calculateStartOfTodayUtc(now);
  if (cutoffDate.getTime() > startOfToday.getTime()) {
    throw new Error(
      `cutoff (${beforeIso}) cannot cross into current UTC day (${startOfToday.toISOString()}) to preserve daily cap accounting`,
    );
  }
  return cutoffDate.toISOString();
}

export async function executeOwnerRetention(
  client: Client,
  options: RetentionOptions,
): Promise<RetentionReceipt> {
  const startTime = Date.now();
  const { ownerId, dryRun = false, now = new Date() } = options;

  if (!ownerId || ownerId.trim() === "") {
    throw new Error("executeOwnerRetention: ownerId is required");
  }

  let cutoff: string;
  if (options.beforeIso !== undefined) {
    cutoff = validateCutoffIso(options.beforeIso, now);
  } else if (options.retentionDays !== undefined) {
    cutoff = calculateSafeCutoff(options.retentionDays, now);
  } else {
    throw new Error("executeOwnerRetention: either beforeIso or retentionDays must be specified");
  }

  // Count candidates
  const jobsCandidateRes = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM jobs WHERE owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
    args: [ownerId, cutoff],
  });
  const usageCandidateRes = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM usage_ledger WHERE owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
    args: [ownerId, cutoff],
  });

  const terminalJobsCandidates = Number(jobsCandidateRes.rows[0]?.c ?? 0);
  const closedUsageCandidates = Number(usageCandidateRes.rows[0]?.c ?? 0);

  if (dryRun) {
    return {
      ownerId,
      cutoff,
      dryRun: true,
      candidates: {
        terminalJobs: terminalJobsCandidates,
        closedUsage: closedUsageCandidates,
      },
      deleted: {
        terminalJobs: 0,
        closedUsage: 0,
      },
      durationMs: Date.now() - startTime,
      success: true,
    };
  }

  // Transactional deletion
  const tx = await client.transaction("write");
  try {
    const jobsRes = await tx.execute({
      sql: "DELETE FROM jobs WHERE owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
      args: [ownerId, cutoff],
    });
    const usageRes = await tx.execute({
      sql: "DELETE FROM usage_ledger WHERE owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
      args: [ownerId, cutoff],
    });

    await tx.commit();

    const jobsDeleted = Number(jobsRes.rowsAffected);
    const usageDeleted = Number(usageRes.rowsAffected);

    return {
      ownerId,
      cutoff,
      dryRun: false,
      candidates: {
        terminalJobs: terminalJobsCandidates,
        closedUsage: closedUsageCandidates,
      },
      deleted: {
        terminalJobs: jobsDeleted,
        closedUsage: usageDeleted,
      },
      durationMs: Date.now() - startTime,
      success: true,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // Ignore rollback failure if tx already closed
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ownerId,
      cutoff,
      dryRun: false,
      candidates: {
        terminalJobs: terminalJobsCandidates,
        closedUsage: closedUsageCandidates,
      },
      deleted: {
        terminalJobs: 0,
        closedUsage: 0,
      },
      durationMs: Date.now() - startTime,
      success: false,
      error: message,
    };
  }
}

export async function pruneOwnerHistory(
  client: Client,
  ownerId: string,
  beforeIso: string,
): Promise<RetentionResult> {
  const receipt = await executeOwnerRetention(client, {
    ownerId,
    beforeIso,
    dryRun: false,
  });

  if (!receipt.success) {
    throw new Error(`pruneOwnerHistory failed: ${receipt.error}`);
  }

  return {
    jobsDeleted: receipt.deleted.terminalJobs,
    usageDeleted: receipt.deleted.closedUsage,
  };
}
