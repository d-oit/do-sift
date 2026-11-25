import { describe, expect, it } from "vitest";
import { aggregateEvalResults, type EvalResultRow } from "../src/index.js";

function row(
  id: string,
  provider: string,
  dataset: string,
  recall: number,
  latencyMs: number,
): EvalResultRow {
  return { id, provider, dataset, recall, latencyMs, createdDay: "2026-11-17" };
}

describe("analytics aggregation (DuckDB, offline only)", () => {
  it("returns no groups for no rows", async () => {
    expect(await aggregateEvalResults([])).toEqual([]);
  });

  it("aggregates provider/dataset groups with the documented statistics", async () => {
    const result = await aggregateEvalResults([
      row("r1", "alpha", "dataset-1", 0.5, 10),
      row("r2", "alpha", "dataset-1", 1, 20),
      row("r3", "alpha", "dataset-2", 0.25, 40),
      row("r4", "beta", "dataset-1", 0, 30),
    ]);
    expect(result).toEqual([
      {
        provider: "alpha",
        dataset: "dataset-1",
        n: 2,
        meanRecall: 0.75,
        minRecall: 0.5,
        maxRecall: 1,
        meanLatency: 15,
      },
      {
        provider: "alpha",
        dataset: "dataset-2",
        n: 1,
        meanRecall: 0.25,
        minRecall: 0.25,
        maxRecall: 0.25,
        meanLatency: 40,
      },
      {
        provider: "beta",
        dataset: "dataset-1",
        n: 1,
        meanRecall: 0,
        minRecall: 0,
        maxRecall: 0,
        meanLatency: 30,
      },
    ]);
  });

  it("matches a plain JavaScript aggregation on a larger deterministic set", async () => {
    const rows: EvalResultRow[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push(
        row(
          `r${i}`,
          ["alpha", "beta", "gamma"][i % 3] ?? "alpha",
          `dataset-${(i % 4) + 1}`,
          (i % 100) / 100,
          (i * 7) % 500,
        ),
      );
    }
    const result = await aggregateEvalResults(rows);

    const groups = new Map<string, EvalResultRow[]>();
    for (const r of rows) {
      const key = `${r.provider}\u0000${r.dataset}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const expected = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, list]) => {
        const recalls = list.map((r) => r.recall);
        return {
          provider: list[0]?.provider,
          dataset: list[0]?.dataset,
          n: list.length,
          meanRecall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
          minRecall: Math.min(...recalls),
          maxRecall: Math.max(...recalls),
          meanLatency: list.reduce((sum, r) => sum + r.latencyMs, 0) / list.length,
        };
      });

    expect(result.length).toBe(expected.length);
    result.forEach((actual, index) => {
      const want = expected[index];
      expect(actual.provider).toBe(want?.provider);
      expect(actual.dataset).toBe(want?.dataset);
      expect(actual.n).toBe(want?.n);
      expect(actual.meanRecall).toBeCloseTo(want?.meanRecall ?? NaN, 9);
      expect(actual.minRecall).toBe(want?.minRecall);
      expect(actual.maxRecall).toBe(want?.maxRecall);
      expect(actual.meanLatency).toBeCloseTo(want?.meanLatency ?? NaN, 9);
    });
  });

  it("rejects input over the row limit instead of aggregating", async () => {
    const rows: EvalResultRow[] = [
      row("r1", "alpha", "dataset-1", 0.5, 10),
      row("r2", "alpha", "dataset-1", 0.5, 10),
      row("r3", "alpha", "dataset-1", 0.5, 10),
    ];
    await expect(aggregateEvalResults(rows, { maxRows: 2 })).rejects.toThrow(/exceeds limit/u);
  });

  it("refuses a pre-aborted signal without touching DuckDB", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      aggregateEvalResults([row("r1", "alpha", "dataset-1", 0.5, 10)], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/u);
  });

  it("times out immediately when timeoutMs is zero", async () => {
    await expect(
      aggregateEvalResults([row("r1", "alpha", "dataset-1", 0.5, 10)], { timeoutMs: 0 }),
    ).rejects.toThrow(/timed out/u);
  });

  it("rejects malformed and duplicated rows instead of aggregating them", async () => {
    await expect(aggregateEvalResults([row("r1", "", "dataset-1", 0.5, 10)])).rejects.toThrow(
      /provider is empty/u,
    );
    await expect(aggregateEvalResults([row("r1", "alpha", "dataset-1", 1.5, 10)])).rejects.toThrow(
      /between 0 and 1/u,
    );
    await expect(aggregateEvalResults([row("r1", "alpha", "dataset-1", 0.5, -1)])).rejects.toThrow(
      /non-negative integer/u,
    );
    await expect(
      aggregateEvalResults([
        row("r1", "alpha", "dataset-1", 0.5, 10),
        row("r1", "alpha", "dataset-1", 0.5, 10),
      ]),
    ).rejects.toThrow(/duplicated/u);
  });
});
