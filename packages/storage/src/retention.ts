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

export async function pruneOwnerHistory(
  client: Client,
  ownerId: string,
  beforeIso: string,
): Promise<RetentionResult> {
  if (Number.isNaN(Date.parse(beforeIso))) {
    throw new Error(`pruneOwnerHistory: cutoff is not a valid ISO timestamp (${beforeIso})`);
  }
  const jobs = await client.execute({
    sql: "DELETE FROM jobs WHERE owner_id = ? AND status IN ('done','dead') AND updated_at < ?",
    args: [ownerId, beforeIso],
  });
  const usage = await client.execute({
    sql: "DELETE FROM usage_ledger WHERE owner_id = ? AND state IN ('settled','expired') AND created_at < ?",
    args: [ownerId, beforeIso],
  });
  return {
    jobsDeleted: Number(jobs.rowsAffected),
    usageDeleted: Number(usage.rowsAffected),
  };
}
