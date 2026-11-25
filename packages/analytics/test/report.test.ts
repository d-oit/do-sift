import { describe, expect, it } from "vitest";
import { buildRetrievalReport, type ReportProvenance } from "../src/report.js";
import type { EvalResultRow } from "../src/index.js";

function row(
  id: string,
  provider: string,
  dataset: string,
  recall: number,
  latencyMs: number,
): EvalResultRow {
  return { id, provider, dataset, recall, latencyMs, createdDay: "2026-11-17" };
}

const provenance: ReportProvenance = {
  datasetVersion: "dataset-2026-11-01",
  baselineVersion: "baseline-7",
  codeRevision: "abc1234",
  reportVersion: "retrieval/v1",
};

describe("retrieval report (offline, deterministic)", () => {
  it("echoes provenance and orders groups by provider then dataset", async () => {
    const result = await buildRetrievalReport(
      [
        row("r2", "beta", "dataset-1", 0, 30),
        row("r1", "alpha", "dataset-2", 0.25, 40),
        row("r0", "alpha", "dataset-1", 0.5, 10),
      ],
      provenance,
    );
    expect(result.provenance).toEqual(provenance);
    expect(result.rowCount).toBe(3);
    expect(result.groups.map((g) => [g.provider, g.dataset])).toEqual([
      ["alpha", "dataset-1"],
      ["alpha", "dataset-2"],
      ["beta", "dataset-1"],
    ]);
  });

  it("returns empty groups for empty input without imputing", async () => {
    const result = await buildRetrievalReport([], provenance);
    expect(result.groups).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("gates p50/p95 on sample size with an explicit reason", async () => {
    const small = await buildRetrievalReport(
      [row("r1", "alpha", "dataset-1", 0.5, 10)],
      provenance,
    );
    expect(small.groups[0]?.p50LatencyMs).toBeNull();
    expect(small.groups[0]?.p95LatencyMs).toBeNull();
    expect(small.groups[0]?.percentileNote).toBe("insufficient-sample");

    const rows: EvalResultRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row(`r${i}`, "alpha", "dataset-1", i / 10, (i + 1) * 10));
    }
    const big = await buildRetrievalReport(rows, provenance);
    expect(big.groups[0]?.p50LatencyMs).toBe(30);
    expect(big.groups[0]?.p95LatencyMs).toBe(50);
    expect(big.groups[0]?.percentileNote).toBeUndefined();
    expect(big.groups[0]?.meanRecall).toBeCloseTo(0.2, 9);
  });

  it("rejects malformed rows instead of reporting them", async () => {
    await expect(
      buildRetrievalReport([row("r1", "", "dataset-1", 0.5, 10)], provenance),
    ).rejects.toThrow(/provider is empty/u);
  });
});
