/**
 * Reproducible provider-health report (issue #157, plan 066).
 *
 * Read-only and deterministic: the same call rows plus the same provenance
 * (and the same verified-cost records, when supplied) produce the same
 * report. There is no wall-clock timestamp and no imputation — calls
 * without a measured `latencyMs` are excluded from the latency distribution
 * and counted via `latencySampleCount`, and calls without a `failureKind`
 * contribute to no failure bucket.
 *
 * Measured observations and verified metadata stay separate: latency,
 * success/error/degraded, timeout/rate-limit, and retry/Retry-After counts
 * are measured from `ProviderCallRow[]`; quota/cost figures appear only when
 * the caller supplies dated, sourced `verifiedCosts` records, echoed
 * verbatim and never inferred from calls. No error-message strings are
 * accepted, so the report cannot leak raw provider output, prompts, or
 * private evidence. Empty input yields `providers: []`.
 *
 * Latency p50/p95 use the nearest-rank method on sorted per-provider
 * latencies and are emitted only when the provider has at least
 * `MIN_LATENCY_SAMPLE_N` measured latencies; smaller samples carry `null`
 * with `percentileNote: "insufficient-sample"`.
 */
import type { ReportProvenance } from "./report.js";

export type ProviderOutcome = "success" | "error" | "degraded";

export type ProviderFailureKind = "timeout" | "rate-limited" | "http" | "aborted" | "unknown";

export interface ProviderCallRow {
  provider: string;
  outcome: ProviderOutcome;
  /** Measured end-to-end latency in ms; unknown when absent. */
  latencyMs?: number | undefined;
  /** Stored failure class; absent means no classified failure. */
  failureKind?: ProviderFailureKind | undefined;
  /** True when at least one retry was consumed for this request. */
  retried?: boolean | undefined;
  /** Observed Retry-After delay in ms; unknown when absent. */
  retryAfterMs?: number | undefined;
}

export interface VerifiedProviderCost {
  provider: string;
  /** Dated source of the figure (price sheet / quota export). */
  source: string;
  verifiedAt: string;
  costMicroUsd?: number | undefined;
  quotaRemaining?: number | undefined;
}

export interface ProviderGroup {
  provider: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  degradedCount: number;
  timeoutCount: number;
  rateLimitedCount: number;
  retryCount: number;
  retryAfterObservedCount: number;
  latencySampleCount: number;
  meanLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  percentileNote?: "insufficient-sample";
}

export interface ProviderHealthReport {
  provenance: ReportProvenance;
  requestCount: number;
  providers: ProviderGroup[];
  verifiedCosts: VerifiedProviderCost[];
}

export const PROVIDER_HEALTH_REPORT_VERSION = "provider-health/v1";

export const MIN_LATENCY_SAMPLE_N = 5;

const OUTCOMES: readonly string[] = ["success", "error", "degraded"];
const FAILURE_KINDS: readonly string[] = ["timeout", "rate-limited", "http", "aborted", "unknown"];

function assertCall(row: ProviderCallRow): void {
  if (row.provider.trim() === "") throw new Error("provider-health provider must not be empty");
  if (!OUTCOMES.includes(row.outcome)) {
    throw new Error(
      `provider-health provider ${row.provider}: outcome must be success, error, or degraded`,
    );
  }
  if (row.latencyMs !== undefined) {
    if (!Number.isInteger(row.latencyMs) || row.latencyMs < 0) {
      throw new Error(
        `provider-health provider ${row.provider}: latencyMs must be a non-negative integer`,
      );
    }
  }
  if (row.failureKind !== undefined && !FAILURE_KINDS.includes(row.failureKind)) {
    throw new Error(`provider-health provider ${row.provider}: failureKind must be a known kind`);
  }
  if (row.retried !== undefined && typeof row.retried !== "boolean") {
    throw new Error(`provider-health provider ${row.provider}: retried must be a boolean`);
  }
  if (row.retryAfterMs !== undefined) {
    if (!Number.isInteger(row.retryAfterMs) || row.retryAfterMs < 0) {
      throw new Error(
        `provider-health provider ${row.provider}: retryAfterMs must be a non-negative integer`,
      );
    }
  }
}

function assertVerifiedCost(record: VerifiedProviderCost): void {
  if (record.provider.trim() === "")
    throw new Error("provider-health verified cost provider must not be empty");
  if (record.source.trim() === "") {
    throw new Error(`provider-health verified cost ${record.provider}: source must not be empty`);
  }
  if (record.verifiedAt.trim() === "") {
    throw new Error(
      `provider-health verified cost ${record.provider}: verifiedAt must not be empty`,
    );
  }
  if (record.costMicroUsd !== undefined) {
    if (!Number.isInteger(record.costMicroUsd) || record.costMicroUsd < 0) {
      throw new Error(
        `provider-health verified cost ${record.provider}: costMicroUsd must be a non-negative integer`,
      );
    }
  }
  if (record.quotaRemaining !== undefined) {
    if (!Number.isInteger(record.quotaRemaining) || record.quotaRemaining < 0) {
      throw new Error(
        `provider-health verified cost ${record.provider}: quotaRemaining must be a non-negative integer`,
      );
    }
  }
}

/** Nearest-rank percentile over ascending-sorted values. */
function nearestRank(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

export async function buildProviderHealthReport(
  calls: readonly ProviderCallRow[],
  provenance: ReportProvenance,
  verifiedCosts: readonly VerifiedProviderCost[] = [],
): Promise<ProviderHealthReport> {
  for (const row of calls) assertCall(row);
  for (const record of verifiedCosts) assertVerifiedCost(record);

  const byProvider = new Map<string, ProviderCallRow[]>();
  for (const row of calls) {
    const list = byProvider.get(row.provider);
    if (list === undefined) byProvider.set(row.provider, [row]);
    else list.push(row);
  }

  const providers: ProviderGroup[] = [...byProvider.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([provider, rows]) => {
      let success = 0;
      let errors = 0;
      let degraded = 0;
      let timeouts = 0;
      let rateLimited = 0;
      let retries = 0;
      let retryAfterObserved = 0;
      const latencies: number[] = [];
      for (const row of rows) {
        if (row.outcome === "success") success++;
        else if (row.outcome === "error") errors++;
        else degraded++;
        if (row.failureKind === "timeout") timeouts++;
        if (row.failureKind === "rate-limited") rateLimited++;
        if (row.retried === true) retries++;
        if (row.retryAfterMs !== undefined) retryAfterObserved++;
        if (row.latencyMs !== undefined) latencies.push(row.latencyMs);
      }
      latencies.sort((a, b) => a - b);
      const latencySampleCount = latencies.length;
      const meanLatencyMs =
        latencySampleCount === 0
          ? null
          : latencies.reduce((sum, value) => sum + value, 0) / latencySampleCount;
      if (latencySampleCount >= MIN_LATENCY_SAMPLE_N) {
        return {
          provider,
          requestCount: rows.length,
          successCount: success,
          errorCount: errors,
          degradedCount: degraded,
          timeoutCount: timeouts,
          rateLimitedCount: rateLimited,
          retryCount: retries,
          retryAfterObservedCount: retryAfterObserved,
          latencySampleCount,
          meanLatencyMs,
          p50LatencyMs: nearestRank(latencies, 0.5),
          p95LatencyMs: nearestRank(latencies, 0.95),
        };
      }
      return {
        provider,
        requestCount: rows.length,
        successCount: success,
        errorCount: errors,
        degradedCount: degraded,
        timeoutCount: timeouts,
        rateLimitedCount: rateLimited,
        retryCount: retries,
        retryAfterObservedCount: retryAfterObserved,
        latencySampleCount,
        meanLatencyMs,
        p50LatencyMs: null,
        p95LatencyMs: null,
        percentileNote: "insufficient-sample" as const,
      };
    });

  return {
    provenance: { ...provenance },
    requestCount: calls.length,
    providers,
    verifiedCosts: verifiedCosts.map((record) => ({ ...record })),
  };
}
