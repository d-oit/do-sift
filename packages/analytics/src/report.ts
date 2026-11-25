/**
 * Reproducible retrieval-quality report (issue #157, plan 060).
 *
 * Read-only and deterministic: the same rows plus the same provenance
 * produce the same report. There is no wall-clock timestamp, no imputation,
 * and no quality claim beyond the stored eval rows. Empty input yields
 * `groups: []` with `rowCount: 0`.
 *
 * Latency p50/p95 use the nearest-rank method on sorted per-group latencies
 * and are emitted only when the group has at least `MIN_PERCENTILE_N` rows;
 * smaller groups carry `null` with `percentileNote: "insufficient-sample"`.
 */
import { aggregateEvalResults, type EvalResultRow } from "./index.js";

export interface ReportProvenance {
  datasetVersion: string;
  baselineVersion: string;
  codeRevision: string;
  reportVersion: string;
}

export interface RetrievalGroup {
  provider: string;
  dataset: string;
  n: number;
  meanRecall: number;
  minRecall: number;
  maxRecall: number;
  meanLatency: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  percentileNote?: "insufficient-sample";
}

export interface RetrievalReport {
  provenance: ReportProvenance;
  rowCount: number;
  groupCount: number;
  groups: RetrievalGroup[];
}

export const MIN_PERCENTILE_N = 5;
export const REPORT_VERSION = "retrieval/v1";

/** Nearest-rank percentile over ascending-sorted values. */
function nearestRank(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

export async function buildRetrievalReport(
  rows: readonly EvalResultRow[],
  provenance: ReportProvenance,
): Promise<RetrievalReport> {
  const aggregates = await aggregateEvalResults(rows);
  const latencies = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.dataset}`;
    const list = latencies.get(key);
    if (list === undefined) latencies.set(key, [row.latencyMs]);
    else list.push(row.latencyMs);
  }
  const groups: RetrievalGroup[] = aggregates.map((agg) => {
    const key = `${agg.provider}\u0000${agg.dataset}`;
    const values = (latencies.get(key) ?? []).slice().sort((a, b) => a - b);
    if (values.length >= MIN_PERCENTILE_N) {
      return {
        ...agg,
        p50LatencyMs: nearestRank(values, 0.5),
        p95LatencyMs: nearestRank(values, 0.95),
      };
    }
    return {
      ...agg,
      p50LatencyMs: null,
      p95LatencyMs: null,
      percentileNote: "insufficient-sample" as const,
    };
  });
  return {
    provenance: { ...provenance },
    rowCount: rows.length,
    groupCount: groups.length,
    groups,
  };
}
