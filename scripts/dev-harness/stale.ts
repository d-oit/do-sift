/**
 * Status verdicts with staleness (DSH-07, plan 010). A green receipt is
 * "stale" when the workspace fingerprint recorded with it differs from the
 * current working tree — a receipt that does not cover the current tree is
 * not a receipt for the current tree. Receipts without a stored fingerprint
 * (pre-DSH-07 events) and runs outside a git repo (no current fingerprint)
 * keep the original green/red/missing semantics: staleness is judged only
 * when both sides of the comparison exist.
 */
import type { SensorStatus } from "./schemas.js";

export type StatusVerdict = "green" | "red" | "stale" | "missing";

export interface LastReceipt {
  status: SensorStatus;
  workspaceSha256?: string | undefined;
}

export function statusVerdict(
  last: LastReceipt | undefined,
  currentFingerprint: string | undefined,
): StatusVerdict {
  if (last === undefined) return "missing";
  if (last.status !== "pass") return "red";
  const { workspaceSha256 } = last;
  if (
    workspaceSha256 !== undefined &&
    currentFingerprint !== undefined &&
    workspaceSha256 !== currentFingerprint
  ) {
    return "stale";
  }
  return "green";
}
