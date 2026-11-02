import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEGRADATION_HISTORY_FILE,
  appendDegradationHistory,
  computeReasonCoverage,
  countDegradationReasons,
  countDegradationReceipts,
  describeReasonCoverage,
  loadDegradationHistory,
  summarizeDegradationRun,
  type DegradationHistoryEntry,
} from "../../scripts/degradation/history.ts";

const ROOT = process.cwd();
const TEST_DIR = join(ROOT, "evals", "test-degradation-history-temp");

function entry(executedAtUtc: string, score = 1): DegradationHistoryEntry {
  return {
    executedAtUtc,
    suiteVersion: "deg-1",
    score,
    scenariosPassed: 1,
    scenariosTotal: 2,
    reasons: { "no-evidence": 1, "citation-invalid": 0, "model-failed": 0, none: 1 },
  };
}

describe("degradation suite history", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("counts every scenario by receipt reason and treats no event as none", () => {
    expect(
      countDegradationReasons([
        { reason: "no-evidence" },
        { reason: "model-failed" },
        { reason: null },
        { reason: "no-evidence" },
      ]),
    ).toEqual({ "no-evidence": 2, "citation-invalid": 0, "model-failed": 1, none: 1 });
  });

  it("counts emitted receipts separately from expected reasons", () => {
    expect(
      countDegradationReceipts([{ receiptReason: "model-failed" }, { receiptReason: null }]),
    ).toEqual({ "no-evidence": 0, "citation-invalid": 0, "model-failed": 1, none: 1 });
  });

  it("summarizes a suite run into a history entry with a complete reason bucket set", () => {
    const summary = summarizeDegradationRun(
      {
        suiteVersion: "deg-1",
        degradationHonesty: 0.5,
        passed: 1,
        total: 2,
        scenarios: [
          { reason: "citation-invalid", receiptReason: "citation-invalid" },
          { reason: null, receiptReason: null },
        ],
      },
      "2026-11-02T10:00:00.000Z",
    );
    expect(summary.reasons).toEqual({
      "no-evidence": 0,
      "citation-invalid": 1,
      "model-failed": 0,
      none: 1,
    });
    expect(summary.score).toBe(0.5);
  });

  it("names the reason bucket a failed run let go missing", () => {
    const coverage = computeReasonCoverage([
      { reason: "model-failed", receiptReason: null },
      { reason: "no-evidence", receiptReason: "no-evidence" },
    ]);
    expect(describeReasonCoverage(coverage)).toEqual([
      "model-failed: expected 1, observed 0 (missing 1)",
      "none: expected 0, observed 1 (unexpected +1)",
    ]);
  });

  it("reports matching coverage as one line", () => {
    const coverage = computeReasonCoverage([
      { reason: "no-evidence", receiptReason: "no-evidence" },
      { reason: null, receiptReason: null },
    ]);
    expect(describeReasonCoverage(coverage)).toEqual([
      "reason buckets match: no-evidence=1, citation-invalid=0, model-failed=0, none=1",
    ]);
  });

  it("rejects a non-finite score instead of recording unusable evidence", () => {
    expect(() =>
      summarizeDegradationRun(
        {
          suiteVersion: "deg-1",
          degradationHonesty: Number.NaN,
          passed: 0,
          total: 1,
          scenarios: [],
        },
        "2026-11-02T10:00:00.000Z",
      ),
    ).toThrow(/finite/);
  });

  it("counts receipts even when a run failed to emit one", () => {
    const summary = summarizeDegradationRun(
      {
        suiteVersion: "deg-1",
        degradationHonesty: 0.5,
        passed: 1,
        total: 2,
        scenarios: [
          { reason: "model-failed", receiptReason: null },
          { reason: "no-evidence", receiptReason: "no-evidence" },
        ],
      },
      "2026-11-02T11:00:00.000Z",
    );
    expect(summary.reasons).toEqual({
      "no-evidence": 1,
      "citation-invalid": 0,
      "model-failed": 0,
      none: 1,
    });
  });

  it("appends in time order and trims to the newest runs without mutating input", () => {
    const existing = [entry("2026-11-02T10:00:00.000Z")];
    const appended = appendDegradationHistory(existing, entry("2026-11-01T10:00:00.000Z"), 2);
    expect(appended.map((run) => run.executedAtUtc)).toEqual([
      "2026-11-01T10:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
    ]);
    expect(existing).toHaveLength(1);

    const trimmed = appendDegradationHistory(appended, entry("2026-11-03T10:00:00.000Z"), 2);
    expect(trimmed.map((run) => run.executedAtUtc)).toEqual([
      "2026-11-02T10:00:00.000Z",
      "2026-11-03T10:00:00.000Z",
    ]);
  });

  it("rejects a nonsensical history limit", () => {
    expect(() => appendDegradationHistory([], entry("2026-11-02T10:00:00.000Z"), 0)).toThrow(
      /positive integer/,
    );
  });

  it("loads runs oldest-first and tolerates missing or corrupt history", () => {
    expect(loadDegradationHistory(TEST_DIR)).toEqual([]);

    writeFileSync(
      join(TEST_DIR, DEGRADATION_HISTORY_FILE),
      JSON.stringify({
        schemaVersion: 1,
        runs: [entry("2026-11-03T10:00:00.000Z"), entry("2026-11-02T10:00:00.000Z")],
      }),
      "utf8",
    );
    expect(loadDegradationHistory(TEST_DIR).map((run) => run.executedAtUtc)).toEqual([
      "2026-11-02T10:00:00.000Z",
      "2026-11-03T10:00:00.000Z",
    ]);

    writeFileSync(join(TEST_DIR, DEGRADATION_HISTORY_FILE), '{"schemaVersion":1}', "utf8");
    expect(loadDegradationHistory(TEST_DIR)).toEqual([]);
  });
});
