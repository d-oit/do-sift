/**
 * Owner-scoped retention (#64). Prunes only rows that can no longer affect
 * behaviour: terminal jobs (`done`/`dead`) and closed usage rows
 * (`settled`/`expired`) older than the cutoff. Open reservations, queued or
 * leased jobs, and evidence (documents, passages, answers) are never touched.
 * Callers pass a cutoff at or before the start of the current UTC day so
 * daily cap accounting for today is never lost.
 */
import type { Client } from "@libsql/client";
import { DEFAULT_TENANT_ID } from "@do-sift/contracts";

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
  /**
   * Tenant the owner belongs to (plan 024). Pruning is scoped by both, so a
   * maintenance run can never touch another tenant's history even with a
   * colliding owner id. Defaults to the migration-0011 backfill tenant.
   */
  tenantId?: string | undefined;
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
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;

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
    sql: "SELECT COUNT(*) AS c FROM jobs WHERE tenant_id = ? AND owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
    args: [tenantId, ownerId, cutoff],
  });
  const usageCandidateRes = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM usage_ledger WHERE tenant_id = ? AND owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
    args: [tenantId, ownerId, cutoff],
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
      sql: "DELETE FROM jobs WHERE tenant_id = ? AND owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
      args: [tenantId, ownerId, cutoff],
    });
    const usageRes = await tx.execute({
      sql: "DELETE FROM usage_ledger WHERE tenant_id = ? AND owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
      args: [tenantId, ownerId, cutoff],
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

/**
 * Membership change log retention (plan 024, MT-11). The change log is an
 * audit trail, so its pruning is deliberately narrower than operational
 * cleanup: one tenant per run, never below the minimum review window, and
 * dry-run unless the operator confirms.
 */

/** Default history kept per tenant: one year of membership changes. */
export const DEFAULT_MEMBER_CHANGE_RETENTION_DAYS = 365;

/** Shortest history the log may be pruned to; below this it stops being a review aid. */
export const MIN_MEMBER_CHANGE_RETENTION_DAYS = 30;

export interface MemberChangeRetentionOptions {
  /** Tenant whose change log is pruned. Required: there is no global sweep. */
  tenantId: string;
  /** Explicit cutoff ISO timestamp. */
  beforeIso?: string | undefined;
  /** Number of days of history to retain relative to current UTC day start. */
  retentionDays?: number | undefined;
  /** If true, counts candidates without deleting rows. */
  dryRun?: boolean | undefined;
  /** Reference time for calculating current UTC day start (defaults to new Date()). */
  now?: Date | undefined;
}

export interface MemberChangeRetentionReceipt {
  tenantId: string;
  cutoff: string;
  dryRun: boolean;
  candidates: number;
  deleted: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Rejects a retention window that would leave less than the minimum history. */
export function validateMemberChangeRetentionDays(retentionDays: number): void {
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_MEMBER_CHANGE_RETENTION_DAYS) {
    throw new Error(
      `membership change retention must keep at least ${MIN_MEMBER_CHANGE_RETENTION_DAYS} days (got ${retentionDays})`,
    );
  }
}

/**
 * Delete one tenant's membership changes older than the cutoff. Returns a
 * receipt; a failed transaction reports `success: false` rather than throwing,
 * so a maintenance run can be logged either way.
 */
export async function pruneMemberChangeLog(
  client: Client,
  options: MemberChangeRetentionOptions,
): Promise<MemberChangeRetentionReceipt> {
  const startTime = Date.now();
  const { dryRun = false, now = new Date() } = options;
  const tenantId = options.tenantId;

  if (tenantId === "" || tenantId.trim() === "") {
    throw new Error("pruneMemberChangeLog: tenantId is required");
  }

  let cutoff: string;
  if (options.beforeIso !== undefined) {
    cutoff = validateCutoffIso(options.beforeIso, now);
  } else if (options.retentionDays !== undefined) {
    validateMemberChangeRetentionDays(options.retentionDays);
    cutoff = calculateSafeCutoff(options.retentionDays, now);
  } else {
    throw new Error("pruneMemberChangeLog: either beforeIso or retentionDays must be specified");
  }

  // The floor also governs an explicit cutoff: pruning an audit log down to the
  // last few days destroys the review window the log exists for.
  const floor = calculateSafeCutoff(MIN_MEMBER_CHANGE_RETENTION_DAYS, now);
  if (Date.parse(cutoff) > Date.parse(floor)) {
    throw new Error(
      `cutoff (${cutoff}) is newer than the ${MIN_MEMBER_CHANGE_RETENTION_DAYS}-day floor (${floor}): membership history must keep at least ${MIN_MEMBER_CHANGE_RETENTION_DAYS} days`,
    );
  }

  const candidateRes = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM tenant_member_changes WHERE tenant_id = ? AND created_at < ?",
    args: [tenantId, cutoff],
  });
  const candidates = Number(candidateRes.rows[0]?.c ?? 0);

  if (dryRun) {
    return {
      tenantId,
      cutoff,
      dryRun: true,
      candidates,
      deleted: 0,
      durationMs: Date.now() - startTime,
      success: true,
    };
  }

  const tx = await client.transaction("write");
  try {
    const res = await tx.execute({
      sql: "DELETE FROM tenant_member_changes WHERE tenant_id = ? AND created_at < ?",
      args: [tenantId, cutoff],
    });
    await tx.commit();
    return {
      tenantId,
      cutoff,
      dryRun: false,
      candidates,
      deleted: Number(res.rowsAffected),
      durationMs: Date.now() - startTime,
      success: true,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // Ignore rollback failure if tx already closed
    }
    return {
      tenantId,
      cutoff,
      dryRun: false,
      candidates,
      deleted: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function pruneOwnerHistory(
  client: Client,
  ownerId: string,
  beforeIso: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<RetentionResult> {
  const receipt = await executeOwnerRetention(client, {
    ownerId,
    beforeIso,
    tenantId,
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
