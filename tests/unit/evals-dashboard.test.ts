import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDashboardHtml,
  DIMENSION_LABELS,
  DIMENSIONS,
  generateDashboard,
  generateTrendChartSvg,
  getCaseScore,
  loadQualityRuns,
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
