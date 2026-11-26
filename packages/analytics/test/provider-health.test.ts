/** Provider-health report (issue #157, plan 066, PH-02): deterministic counts, gated latencies, verified-cost separation. */
import { describe, expect, it } from "vitest";
import { buildProviderHealthReport, type ProviderCallRow } from "../src/provider-health.js";

const PROVENANCE = {
  datasetVersion: "evals/v12",
  baselineVersion: "ret-baseline/v2",
  codeRevision: "deadbeef",
  reportVersion: "provider-health/v1",
};

const CALLS: ProviderCallRow[] = [
  { provider: "beta", outcome: "success", latencyMs: 30 },
  { provider: "alpha", outcome: "success", latencyMs: 10 },
  { provider: "alpha", outcome: "error", failureKind: "timeout", retried: true },
  {
    provider: "alpha",
    outcome: "degraded",
    latencyMs: 20,
    failureKind: "rate-limited",
    retried: true,
    retryAfterMs: 1000,
  },
  { provider: "alpha", outcome: "success", latencyMs: 40 },
  { provider: "alpha", outcome: "success", latencyMs: 50 },
  { provider: "alpha", outcome: "success", latencyMs: 60 },
];

describe("buildProviderHealthReport", () => {
  it("echoes provenance and orders providers deterministically with counts", async () => {
    const report = await buildProviderHealthReport(CALLS, PROVENANCE);
    expect(report.provenance).toEqual(PROVENANCE);
    expect(report.requestCount).toBe(7);
    expect(report.providers.map((p) => p.provider)).toEqual(["alpha", "beta"]);
    const alpha = report.providers[0];
    expect(alpha?.requestCount).toBe(6);
    expect(alpha?.successCount).toBe(4);
    expect(alpha?.errorCount).toBe(1);
    expect(alpha?.degradedCount).toBe(1);
    expect(alpha?.timeoutCount).toBe(1);
    expect(alpha?.rateLimitedCount).toBe(1);
    expect(alpha?.retryCount).toBe(2);
    expect(alpha?.retryAfterObservedCount).toBe(1);
  });

  it("gates p50/p95 on sample size and leaves mean null without latencies", async () => {
    const report = await buildProviderHealthReport(CALLS, PROVENANCE);
    const alpha = report.providers[0];
    // alpha latencies: 10,20,40,50,60 -> p50=40, p95=60
    expect(alpha?.latencySampleCount).toBe(5);
    expect(alpha?.meanLatencyMs).toBeCloseTo(36);
    expect(alpha?.p50LatencyMs).toBe(40);
    expect(alpha?.p95LatencyMs).toBe(60);
    expect(alpha?.percentileNote).toBeUndefined();

    const small = await buildProviderHealthReport(
      [{ provider: "beta", outcome: "success", latencyMs: 30 }],
      PROVENANCE,
    );
    expect(small.providers[0]?.p50LatencyMs).toBeNull();
    expect(small.providers[0]?.p95LatencyMs).toBeNull();
    expect(small.providers[0]?.percentileNote).toBe("insufficient-sample");

    const noLatency = await buildProviderHealthReport(
      [{ provider: "gamma", outcome: "error", failureKind: "http" }],
      PROVENANCE,
    );
    expect(noLatency.providers[0]?.latencySampleCount).toBe(0);
    expect(noLatency.providers[0]?.meanLatencyMs).toBeNull();
    expect(noLatency.providers[0]?.p50LatencyMs).toBeNull();
  });

  it("keeps verified cost metadata separate and never infers it from calls", async () => {
    const empty = await buildProviderHealthReport(CALLS, PROVENANCE);
    expect(empty.verifiedCosts).toEqual([]);

    const verified = await buildProviderHealthReport(CALLS, PROVENANCE, [
      {
        provider: "alpha",
        source: "price-sheet-2026-11",
        verifiedAt: "2026-11-20",
        costMicroUsd: 123,
      },
    ]);
    expect(verified.verifiedCosts).toEqual([
      {
        provider: "alpha",
        source: "price-sheet-2026-11",
        verifiedAt: "2026-11-20",
        costMicroUsd: 123,
      },
    ]);
    // measured groups unchanged by verified metadata
    expect(verified.providers).toEqual(empty.providers);
  });

  it("yields empty providers for empty input", async () => {
    const report = await buildProviderHealthReport([], PROVENANCE);
    expect(report.requestCount).toBe(0);
    expect(report.providers).toEqual([]);
    expect(report.verifiedCosts).toEqual([]);
  });

  it("rejects malformed rows instead of imputing them", async () => {
    await expect(
      buildProviderHealthReport([{ provider: "", outcome: "success" }], PROVENANCE),
    ).rejects.toThrow();
    await expect(
      buildProviderHealthReport(
        [{ provider: "a", outcome: "nope" } as unknown as ProviderCallRow],
        PROVENANCE,
      ),
    ).rejects.toThrow();
    await expect(
      buildProviderHealthReport([{ provider: "a", outcome: "success", latencyMs: -1 }], PROVENANCE),
    ).rejects.toThrow();
    await expect(
      buildProviderHealthReport(
        [{ provider: "a", outcome: "success", retryAfterMs: -5 }],
        PROVENANCE,
      ),
    ).rejects.toThrow();
  });

  it("is deterministic for identical inputs", async () => {
    const first = await buildProviderHealthReport(CALLS, PROVENANCE);
    const second = await buildProviderHealthReport(CALLS, PROVENANCE);
    expect(second).toEqual(first);
  });
});
