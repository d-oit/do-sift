import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DegradationHistoryEntry } from "../../scripts/degradation/history.ts";
import {
  buildDashboardHtml,
  describeCoverageShifts,
  describeReasonChanges,
  DIMENSION_LABELS,
  recentCoverageSplit,
  DIMENSIONS,
  generateDashboard,
  generateTrendChartSvg,
  getCaseScore,
  loadDegradationArtifact,
  loadQualityRuns,
  summarizeReasonTotals,
  type QualityRun,
} from "../../scripts/evals-dashboard.ts";

const ROOT = process.cwd();
const TEST_DIR = join(ROOT, "evals", "test-dashboard-temp");

describe("Evals Dashboard Generator", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("loads quality runs and sorts them in ascending run order", () => {
    const runA: QualityRun = {
      runId: "run-002",
      executedAtUtc: "2026-09-14",
      aggregates: { meanAll: 0.85 },
      cases: [],
    };
    const runB: QualityRun = {
      runId: "run-001",
      executedAtUtc: "2026-09-14",
      aggregates: { meanAll: 0.775 },
      cases: [],
    };

    writeFileSync(join(TEST_DIR, "run-002.json"), JSON.stringify(runA), "utf8");
    writeFileSync(join(TEST_DIR, "run-001.json"), JSON.stringify(runB), "utf8");

    const loaded = loadQualityRuns(TEST_DIR);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.runId).toBe("run-001");
    expect(loaded[1]?.runId).toBe("run-002");
  });

  it("calculates numeric case average scores accurately", () => {
    expect(getCaseScore(undefined)).toBeNull();
    expect(getCaseScore({})).toBeNull();
    expect(
      getCaseScore({
        retrievalRelevance: 1,
        extractionCleanliness: 0.5,
        citationResolution: 1,
        degradationHonesty: 1,
        injectionObservation: 1,
      }),
    ).toBeCloseTo(0.9);

    expect(
      getCaseScore({
        retrievalRelevance: "n/a (constructed corpus)",
        extractionCleanliness: "n/a (constructed corpus)",
        citationResolution: 1,
        degradationHonesty: "n/a (nothing degraded)",
        injectionObservation: 1,
      }),
    ).toBeCloseTo(1.0);
  });

  it("generates an SVG trend chart containing score points and series high indicator", () => {
    const runs: QualityRun[] = [
      {
        runId: "run-012",
        executedAtUtc: "2026-09-19",
        aggregates: { meanAll: 0.9625 },
        cases: [],
      },
      {
        runId: "run-016",
        executedAtUtc: "2026-09-21",
        aggregates: { meanAll: 0.95 },
        cases: [],
      },
    ];

    const svg = generateTrendChartSvg(runs);
    expect(svg).toContain("<svg");
    expect(svg).toContain("run-012");
    expect(svg).toContain("run-016");
    expect(svg).toContain("0.963 ★"); // Series high star marker
  });

  it("builds self-contained dashboard HTML with heatmap, trend chart, diff view, and limits", () => {
    const runs = loadQualityRuns(join(ROOT, "evals", "quality"));
    expect(runs.length).toBeGreaterThanOrEqual(16);

    const html = buildDashboardHtml(runs);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("do-sift Quality Evals Dashboard");
    expect(html).toContain("Score Trend (Mean Score per Run)");
    expect(html).toContain("Per-Question Scores Matrix");
    expect(html).toContain("Run Comparison &amp; Degradation Diff");
    expect(html).toContain("R-06 Limits &amp; Guidance");

    // All dimensions exist in labels
    for (const dim of DIMENSIONS) {
      expect(html).toContain(DIMENSION_LABELS[dim]);
    }

    // Baseline and target comparison options include run-012 and run-016
    expect(html).toContain('value="run-012"');
    expect(html).toContain('value="run-016"');
  });

  it("executes generateDashboard and writes evals/dashboard/index.html", () => {
    const outDir = join(TEST_DIR, "output");
    const res = generateDashboard(join(ROOT, "evals", "quality"), outDir);
    expect(res.runCount).toBeGreaterThan(0);
    expect(existsSync(res.outputPath)).toBe(true);

    const content = readFileSync(res.outputPath, "utf8");
    expect(content).toContain("<html");
    expect(content).toContain("run-012");
    expect(content).toContain("run-016");
  });

  it("diff view accurately reflects degradation in retrieval relevance between run-012 and run-016", () => {
    const runs = loadQualityRuns(join(ROOT, "evals", "quality"));
    const r12 = runs.find((r) => r.runId === "run-012");
    const r16 = runs.find((r) => r.runId === "run-016");

    expect(r12).toBeDefined();
    expect(r16).toBeDefined();
    expect(r12?.aggregates?.meanAll).toBe(0.9625);
    expect(r16?.aggregates?.meanAll).toBe(0.95);

    // Specifically check that questions like "What causes auroras?" degraded from 1 to 0.5 retrieval relevance
    const aurora12 = r12?.cases?.find((c) => c.question === "What causes auroras?");
    const aurora16 = r16?.cases?.find((c) => c.question === "What causes auroras?");
    expect(aurora12?.scores.retrievalRelevance).toBe(1);
    expect(aurora16?.scores.retrievalRelevance).toBe(0.5);

    // mRNA vaccination also degraded retrievalRelevance from 1 to 0.5
    const mrna12 = r12?.cases?.find((c) => c.question === "How does mRNA vaccination work?");
    const mrna16 = r16?.cases?.find((c) => c.question === "How does mRNA vaccination work?");
    expect(mrna12?.scores.retrievalRelevance).toBe(1);
    expect(mrna16?.scores.retrievalRelevance).toBe(0.5);
  });

  it("loads the degradation artifact and tolerates a missing directory", () => {
    expect(loadDegradationArtifact(TEST_DIR)).toBeNull();

    writeFileSync(
      join(TEST_DIR, "latest.json"),
      JSON.stringify({ qualityGate: { score: 1 }, scenarios: [] }),
      "utf8",
    );
    expect(loadDegradationArtifact(TEST_DIR)?.qualityGate?.score).toBe(1);
  });

  it("renders the degradation-honesty panel with score, reasons, and per-scenario status", () => {
    const html = buildDashboardHtml([], {
      suiteVersion: "deg-1",
      qualityGate: { score: 0.5, scenariosPassed: 1, scenariosTotal: 2 },
      scenarios: [
        {
          id: "model-synthesis-failure",
          name: "Model fails",
          passed: true,
          checks: "20/20",
          degraded: true,
          reason: "model-failed",
        },
        {
          id: "partial-citation-failure",
          name: "Partial citations",
          passed: false,
          checks: "19/20",
          degraded: true,
          reason: "citation-invalid",
        },
      ],
    });

    expect(html).toContain("Degradation Honesty (failure-mode suite)");
    expect(html).toContain("0.500 across 1/2 scenarios");
    expect(html).toContain("model failed");
    expect(html).toContain("citation invalid");
    expect(html).toContain("model-synthesis-failure");
    expect(html).toContain("PASS");
    expect(html).toContain("FAIL");
  });

  it("explains a missing degradation artifact instead of failing", () => {
    const html = buildDashboardHtml([], null);
    expect(html).toContain("No degradation artifact recorded yet");
    expect(html).toContain("npm run evals:degradation");
  });

  it("trends reason counts across recorded suite runs, oldest first", () => {
    const html = buildDashboardHtml(
      [],
      {
        suiteVersion: "deg-1",
        executedAtUtc: "2026-11-02T10:00:00.000Z",
        qualityGate: { score: 1, scenariosPassed: 7, scenariosTotal: 7 },
        scenarios: [],
      },
      [
        {
          executedAtUtc: "2026-11-01T09:00:00.000Z",
          suiteVersion: "deg-1",
          score: 0.857,
          scenariosPassed: 6,
          scenariosTotal: 7,
          reasons: { "no-evidence": 2, "citation-invalid": 1, "model-failed": 1, none: 3 },
        },
        {
          executedAtUtc: "2026-11-02T10:00:00.000Z",
          suiteVersion: "deg-1",
          score: 1,
          scenariosPassed: 7,
          scenariosTotal: 7,
          reasons: { "no-evidence": 2, "citation-invalid": 1, "model-failed": 1, none: 3 },
        },
      ],
    );

    expect(html).toContain("Reason Counts Across Suite Runs");
    expect(html).toContain("2 recorded run(s), oldest first");
    expect(html.indexOf("2026-11-01")).toBeLessThan(html.indexOf("2026-11-02"));
    expect(html).toContain("0.857");
    expect(html).toContain("latest");
    expect(html).toContain("Latest artifact: 2026-11-02");
  });

  it("sums each reason bucket across every recorded run", () => {
    const history = [
      {
        executedAtUtc: "2026-11-01T09:00:00.000Z",
        suiteVersion: "deg-1",
        score: 0.857,
        scenariosPassed: 6,
        scenariosTotal: 7,
        reasons: { "no-evidence": 2, "citation-invalid": 1, "model-failed": 1, none: 3 },
      },
      {
        executedAtUtc: "2026-11-02T10:00:00.000Z",
        suiteVersion: "deg-1",
        score: 1,
        scenariosPassed: 7,
        scenariosTotal: 7,
        reasons: { "no-evidence": 2, "citation-invalid": 1, "model-failed": 0, none: 4 },
      },
    ];

    const lifetime = summarizeReasonTotals(history);
    expect(lifetime.runCount).toBe(2);
    expect(lifetime.totals).toEqual({
      "no-evidence": 4,
      "citation-invalid": 2,
      "model-failed": 1,
      none: 7,
    });
    expect(lifetime.runsWithBucket).toEqual({
      "no-evidence": 2,
      "citation-invalid": 2,
      "model-failed": 1,
      none: 2,
    });
    expect(summarizeReasonTotals([]).totals).toEqual({
      "no-evidence": 0,
      "citation-invalid": 0,
      "model-failed": 0,
      none: 0,
    });

    const html = buildDashboardHtml(
      [],
      {
        suiteVersion: "deg-1",
        executedAtUtc: "2026-11-02T10:00:00.000Z",
        qualityGate: { score: 1, scenariosPassed: 7, scenariosTotal: 7 },
        scenarios: [],
      },
      history,
    );

    expect(html).toContain("Lifetime total &middot; 2 run(s)");
    expect(html).toContain("13/14");
    // A bucket that appeared only in the failed run keeps its count and coverage.
    expect(html).toContain('1<span class="bucket-total-runs"> &middot; 1/2 runs</span>');
    expect(html).toContain('4<span class="bucket-total-runs"> &middot; 2/2 runs</span>');
  });

  it("flags reason buckets whose coverage shrank across the recency-weighted split", () => {
    const artifact = {
      suiteVersion: "deg-1",
      executedAtUtc: "2026-11-02T10:00:00.000Z",
      qualityGate: { score: 1, scenariosPassed: 7, scenariosTotal: 7 },
      scenarios: [],
    };
    const entry = (day: string, modelFailed: number): DegradationHistoryEntry => ({
      executedAtUtc: `${day}T09:00:00.000Z`,
      suiteVersion: "deg-1",
      score: modelFailed > 0 ? 1 : 0.857,
      scenariosPassed: modelFailed > 0 ? 7 : 6,
      scenariosTotal: 7,
      reasons: {
        "no-evidence": 2,
        "citation-invalid": 1,
        "model-failed": modelFailed,
        none: modelFailed > 0 ? 3 : 4,
      },
    });

    const history = [
      entry("2026-11-01", 1),
      entry("2026-11-01", 1),
      entry("2026-11-02", 0),
      entry("2026-11-02", 0),
    ];

    expect(describeCoverageShifts(history)).toEqual([
      {
        bucket: "model-failed",
        direction: "shrinking",
        earlierRuns: 2,
        earlierWithBucket: 2,
        earlierReceipts: 2,
        recentRuns: 2,
        recentWithBucket: 0,
        recentReceipts: 0,
      },
    ]);
    // A single run has no windows to compare, and flat coverage is not a note.
    expect(describeCoverageShifts([entry("2026-11-01", 1)])).toEqual([]);
    expect(describeCoverageShifts([entry("2026-11-01", 1), entry("2026-11-02", 1)])).toEqual([]);
    expect(describeCoverageShifts([entry("2026-11-01", 0), entry("2026-11-02", 0)])).toEqual([]);

    const html = buildDashboardHtml([], artifact, history);
    expect(html).toContain('<span class="reason-pill score-partial">Coverage shrinking</span>');
    expect(html).toContain("2/2 &rarr; 0/2 runs");
    expect(
      buildDashboardHtml([], artifact, [entry("2026-11-01", 1), entry("2026-11-02", 1)]),
    ).not.toContain("Coverage shrinking");
  });

  it("notes a reason bucket whose coverage grew across the recency split", () => {
    const artifact = {
      suiteVersion: "deg-1",
      executedAtUtc: "2026-11-02T10:00:00.000Z",
      qualityGate: { score: 1, scenariosPassed: 7, scenariosTotal: 7 },
      scenarios: [],
    };
    const entry = (day: string, modelFailed: number): DegradationHistoryEntry => ({
      executedAtUtc: `${day}T09:00:00.000Z`,
      suiteVersion: "deg-1",
      score: modelFailed > 0 ? 1 : 0.857,
      scenariosPassed: modelFailed > 0 ? 7 : 6,
      scenariosTotal: 7,
      reasons: {
        "no-evidence": 2,
        "citation-invalid": 1,
        "model-failed": modelFailed,
        none: modelFailed > 0 ? 3 : 4,
      },
    });

    const history = [
      entry("2026-11-01", 0),
      entry("2026-11-01", 0),
      entry("2026-11-02", 1),
      entry("2026-11-02", 1),
    ];

    expect(describeCoverageShifts(history)).toEqual([
      {
        bucket: "model-failed",
        direction: "growing",
        earlierRuns: 2,
        earlierWithBucket: 0,
        earlierReceipts: 0,
        recentRuns: 2,
        recentWithBucket: 2,
        recentReceipts: 2,
      },
    ]);

    const html = buildDashboardHtml([], artifact, history);
    expect(html).toContain('<span class="reason-pill score-pass">Coverage growing</span>');
    expect(html).toContain("0/2 &rarr; 2/2 runs");
    expect(html).not.toContain("Coverage shrinking");
  });

  it("does not call a bucket recovering when only its share of runs rose", () => {
    const artifact = {
      suiteVersion: "deg-1",
      executedAtUtc: "2026-11-02T10:00:00.000Z",
      qualityGate: { score: 1, scenariosPassed: 7, scenariosTotal: 7 },
      scenarios: [],
    };
    const entry = (minute: number, modelFailed: number): DegradationHistoryEntry => ({
      executedAtUtc: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
      suiteVersion: "deg-1",
      score: 1,
      scenariosPassed: 7,
      scenariosTotal: 7,
      reasons: {
        "no-evidence": 2,
        "citation-invalid": 1,
        "model-failed": modelFailed,
        none: 3,
      },
    });

    // Ten runs split 6/4: the earlier six runs emit the bucket twice (ten
    // receipts), and a scenario added late makes the four newest runs emit it
    // once each. Coverage widens from 2/6 to 4/4 runs while the suite emits
    // fewer receipts (10 → 4), so this is a wider net, not a recovery.
    const widened = [
      entry(0, 5),
      entry(1, 5),
      entry(2, 0),
      entry(3, 0),
      entry(4, 0),
      entry(5, 0),
      entry(6, 1),
      entry(7, 1),
      entry(8, 1),
      entry(9, 1),
    ];

    expect(describeCoverageShifts(widened)).toEqual([]);
    const html = buildDashboardHtml([], artifact, widened);
    expect(html).not.toContain("Coverage growing");
    expect(html).not.toContain("Coverage shrinking");

    // Once the newest runs emit more receipts than the earlier window (12 → 10)
    // the bucket covers more runs and produces more receipts, so it is reported.
    const recovered = widened.map((run, index) =>
      index >= 6
        ? {
            ...run,
            reasons: { ...run.reasons, "model-failed": 3, none: 1 },
          }
        : run,
    );
    expect(describeCoverageShifts(recovered)).toEqual([
      {
        bucket: "model-failed",
        direction: "growing",
        earlierRuns: 6,
        earlierWithBucket: 2,
        earlierReceipts: 10,
        recentRuns: 4,
        recentWithBucket: 4,
        recentReceipts: 12,
      },
    ]);
  });

  it("weights the coverage split toward the newest runs", () => {
    // A short history still splits near its midpoint; a full 30-run history
    // weighs its newest seven runs against the twenty-three before them.
    expect(recentCoverageSplit(1)).toBe(1);
    expect(recentCoverageSplit(2)).toBe(1);
    expect(recentCoverageSplit(4)).toBe(2);
    expect(recentCoverageSplit(10)).toBe(6);
    expect(recentCoverageSplit(30)).toBe(23);

    const entry = (minute: number, modelFailed: number): DegradationHistoryEntry => ({
      executedAtUtc: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
      suiteVersion: "deg-1",
      score: modelFailed > 0 ? 1 : 0.857,
      scenariosPassed: modelFailed > 0 ? 7 : 6,
      scenariosTotal: 7,
      reasons: {
        "no-evidence": 2,
        "citation-invalid": 1,
        "model-failed": modelFailed,
        none: modelFailed > 0 ? 3 : 4,
      },
    });

    // Ten early runs emitted the bucket, thirteen in the middle did not, and the
    // seven newest runs emit it again. Recency weighting compares those 10/23
    // runs against 7/7 instead of two fixed 15-run halves, and each run emits a
    // single receipt, so the newest window's seven receipts against the earlier
    // window's ten keep this a coverage trend rather than a recovery (see the
    // receipt rule in the recovery test below).
    const history = [
      ...Array.from({ length: 10 }, (_, i) => entry(i, 1)),
      ...Array.from({ length: 13 }, (_, i) => entry(10 + i, 0)),
      ...Array.from({ length: 7 }, (_, i) => entry(23 + i, 1)),
    ];

    expect(history).toHaveLength(30);
    const artifact = {
      suiteVersion: "deg-1",
      executedAtUtc: "2026-11-02T10:00:00.000Z",
      qualityGate: { score: 1, scenariosPassed: 7, scenariosTotal: 7 },
      scenarios: [],
    };

    expect(describeCoverageShifts(history)).toEqual([]);
    expect(describeCoverageShifts(history.slice(0, 10))).toEqual([]);
    const html = buildDashboardHtml([], artifact, history);
    expect(html).not.toContain("Coverage shrinking");
    expect(html).not.toContain("Coverage growing");
  });

  it("highlights trend rows whose reason buckets moved since the previous run", () => {
    const history = [
      {
        executedAtUtc: "2026-11-01T09:00:00.000Z",
        suiteVersion: "deg-1",
        score: 1,
        scenariosPassed: 7,
        scenariosTotal: 7,
        reasons: { "no-evidence": 2, "citation-invalid": 2, "model-failed": 1, none: 2 },
      },
      {
        executedAtUtc: "2026-11-02T09:00:00.000Z",
        suiteVersion: "deg-1",
        score: 0.857,
        scenariosPassed: 6,
        scenariosTotal: 7,
        reasons: { "no-evidence": 2, "citation-invalid": 2, "model-failed": 0, none: 3 },
      },
      {
        executedAtUtc: "2026-11-02T10:00:00.000Z",
        suiteVersion: "deg-1",
        score: 0.857,
        scenariosPassed: 6,
        scenariosTotal: 7,
        reasons: { "no-evidence": 2, "citation-invalid": 2, "model-failed": 0, none: 3 },
      },
    ];

    expect(describeReasonChanges(history[0]!, history[0]!)).toBeNull();
    expect(describeReasonChanges(history[1]!, history[0]!)).toBe("model-failed -1, none +1");
    expect(describeReasonChanges(history[2]!, history[1]!)).toBeNull();

    const html = buildDashboardHtml(
      [],
      {
        suiteVersion: "deg-1",
        executedAtUtc: "2026-11-02T10:00:00.000Z",
        qualityGate: { score: 0.857, scenariosPassed: 6, scenariosTotal: 7 },
        scenarios: [],
      },
      history,
    );

    // Only the row that lost the model-failed bucket is highlighted.
    expect(html.match(/<tr class="bucket-changed">/g)).toHaveLength(1);
    expect(html).toContain("model-failed -1, none +1");
    expect(html).toContain("Change vs previous");
    expect(html.match(/unchanged/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("first recorded run");
  });

  it("README.md links to evals/dashboard/index.html and package.json defines evals:dashboard", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("evals/dashboard/index.html");
    expect(readme).toContain("npm run evals:dashboard");

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["evals:dashboard"]).toBe("tsx scripts/evals-dashboard.ts");

    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("npm run evals:dashboard");
  });
});
