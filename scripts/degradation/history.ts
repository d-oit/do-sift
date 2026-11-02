/**
 * Degradation-suite run history. `latest.json` is a single snapshot; this
 * module appends one compact entry per suite run to
 * `evals/degradation/history.json` so the dashboard can trend reason counts
 * across runs instead of rendering one run's composition.
 *
 * History is evidence, not a gate: `npm run check` still scores the current
 * suite run in memory (scripts/eval.ts), and a malformed history file only
 * costs the trend view, never the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Receipt reasons the failure-mode suite can expect from the answer path. */
export const DEGRADATION_RECEIPT_REASONS = [
  "no-evidence",
  "citation-invalid",
  "model-failed",
] as const;

export type DegradationReceiptReason = (typeof DEGRADATION_RECEIPT_REASONS)[number];

/** Recorded buckets per run: every receipt reason plus "none" (no degradation). */
export const DEGRADATION_REASON_BUCKETS = [...DEGRADATION_RECEIPT_REASONS, "none"] as const;

export type DegradationReasonBucket = (typeof DEGRADATION_REASON_BUCKETS)[number];

/** Newest runs kept in `history.json`; older entries are dropped, not mutated. */
export const DEGRADATION_HISTORY_LIMIT = 30;

export const DEGRADATION_HISTORY_FILE = "history.json";

export interface DegradationHistoryEntry {
  executedAtUtc: string;
  suiteVersion: string;
  score: number;
  scenariosPassed: number;
  scenariosTotal: number;
  reasons: Record<DegradationReasonBucket, number>;
}

export interface DegradationHistory {
  schemaVersion: 1;
  runs: DegradationHistoryEntry[];
}

/** The subset of a suite result the history needs. */
export interface DegradationRunSummary {
  suiteVersion: string;
  degradationHonesty: number;
  passed: number;
  total: number;
  scenarios: ReadonlyArray<{ reason: DegradationReceiptReason | null }>;
}

/** Counts each scenario by its expected degradation reason (or "none"). */
export function countDegradationReasons(
  scenarios: ReadonlyArray<{ reason: DegradationReceiptReason | null }>,
): Record<DegradationReasonBucket, number> {
  const counts: Record<DegradationReasonBucket, number> = {
    "no-evidence": 0,
    "citation-invalid": 0,
    "model-failed": 0,
    none: 0,
  };
  for (const scenario of scenarios) {
    counts[scenario.reason ?? "none"] += 1;
  }
  return counts;
}

/** Builds one history entry from a finished suite run. */
export function summarizeDegradationRun(
  result: DegradationRunSummary,
  executedAtUtc: string,
): DegradationHistoryEntry {
  if (!Number.isFinite(result.degradationHonesty)) {
    throw new Error(`degradation score must be finite (got ${result.degradationHonesty})`);
  }
  return {
    executedAtUtc,
    suiteVersion: result.suiteVersion,
    score: result.degradationHonesty,
    scenariosPassed: result.passed,
    scenariosTotal: result.total,
    reasons: countDegradationReasons(result.scenarios),
  };
}

/**
 * Returns a new, ascending-by-time history with `entry` appended and trimmed
 * to the newest `limit` runs. The input array is never mutated.
 */
export function appendDegradationHistory(
  existing: readonly DegradationHistoryEntry[],
  entry: DegradationHistoryEntry,
  limit: number = DEGRADATION_HISTORY_LIMIT,
): DegradationHistoryEntry[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`history limit must be a positive integer (got ${limit})`);
  }
  const runs = [...existing, entry].sort((a, b) => a.executedAtUtc.localeCompare(b.executedAtUtc));
  return runs.slice(Math.max(0, runs.length - limit));
}

/** Loads recorded runs oldest-first; a missing or unreadable file yields none. */
export function loadDegradationHistory(degradationDir: string): DegradationHistoryEntry[] {
  const path = join(degradationDir, DEGRADATION_HISTORY_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DegradationHistory>;
    if (!Array.isArray(parsed.runs)) {
      throw new Error("history has no runs array");
    }
    return [...parsed.runs].sort((a, b) => a.executedAtUtc.localeCompare(b.executedAtUtc));
  } catch (err) {
    console.warn(`Failed parsing ${path}:`, err);
    return [];
  }
}
