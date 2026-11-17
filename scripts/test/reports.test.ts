import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotManifest,
  type SnapshotRecord,
} from "@do-sift/contracts";
import { buildReports, renderReportMarkdown } from "../reports.js";

const manifest: SnapshotManifest = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  datasetVersion: "2026-11",
  codeRevision: "abc123",
  createdAt: "2026-11-17T00:00:00.000Z",
  rowCount: 3,
  sha256: "deadbeef",
};

const records: SnapshotRecord[] = [
  {
    runId: "r1",
    fixtureId: "q1",
    datasetVersion: "2026-11",
    mode: "search",
    configuration: { provider: "alpha" },
    metrics: {
      "retrieval.recallAtK": 0.5,
      "retrieval.mrr": 0.4,
      "source.unknownDates": 1,
      "provider.latencyMs": 100,
    },
  },
  {
    runId: "r2",
    fixtureId: "q2",
    datasetVersion: "2026-11",
    mode: "search",
    configuration: { provider: "alpha" },
    metrics: {
      "retrieval.recallAtK": 1,
      "retrieval.mrr": 0.6,
      "source.unknownDates": 3,
      "provider.failures": 1,
      "provider.latencyMs": 300,
    },
  },
  {
    runId: "r3",
    fixtureId: "q3",
    datasetVersion: "2026-11",
    mode: "search",
    configuration: { provider: "beta" },
    metrics: { "retrieval.recallAtK": 0.25, "retrieval.mrr": 0.2 },
  },
];

describe("offline reports", () => {
  it("groups by configuration, records sample counts, and never zero-fills", () => {
    const bundle = buildReports(manifest, records);
    expect(bundle.snapshot.codeRevision).toBe("abc123");
    expect(bundle.retrieval).toHaveLength(2);
    const alpha = bundle.retrieval.find((g) => g.configuration["provider"] === "alpha");
    expect(alpha?.metrics["retrieval.recallAtK"]).toEqual({ n: 2, mean: 0.75, min: 0.5, max: 1 });
    // beta never reported a latency metric, so it is absent, not zero
    const beta = bundle.retrieval.find((g) => g.configuration["provider"] === "beta");
    expect(beta?.metrics["provider.latencyMs"]).toBeUndefined();
  });

  it("separates source metrics and provider observations", () => {
    const bundle = buildReports(manifest, records);
    expect(bundle.sourceQuality.recordsWithSourceMetrics).toBe(2);
    expect(bundle.sourceQuality.metrics["source.unknownDates"]?.n).toBe(2);
    expect(bundle.providerHealth).toEqual([
      {
        provider: "alpha",
        observations: 2,
        ok: 1,
        degraded: 0,
        failed: 1,
        latencyMs: { n: 2, mean: 200, min: 100, max: 300 },
      },
      { provider: "beta", observations: 1, ok: 1, degraded: 0, failed: 0 },
    ]);
  });

  it("is byte-deterministic and labels descriptive counts", () => {
    const a = renderReportMarkdown(buildReports(manifest, records));
    const b = renderReportMarkdown(buildReports(manifest, [...records].reverse()));
    expect(a).toBe(b);
    expect(a).toContain("| retrieval.recallAtK | 2 | 0.75 | 0.5 | 1 |");
    expect(a).toContain("never a reliability or truth score");
  });

  it("refuses an empty dataset", () => {
    expect(() => buildReports({ ...manifest, rowCount: 0 }, [])).toThrow(/at least one record/u);
  });
});
