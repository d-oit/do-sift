/** Degradation-honesty suite (issue #127): failure-mode scenarios are the quality gate's score source. */
import { beforeAll, describe, expect, it } from "vitest";
import {
  computeDegradationHonesty,
  runDegradationSuite,
  type DegradationSuiteResult,
} from "../../scripts/degradation/run.js";

describe("degradation honesty suite (issue #127)", () => {
  let result: DegradationSuiteResult;

  beforeAll(async () => {
    result = await runDegradationSuite();
  }, 60_000);

  it("runs at least five failure scenarios and every expectation holds", () => {
    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.scenarios.map((scenario) => scenario.id)).toEqual([
      "search-no-results",
      "search-provider-timeout",
      "model-synthesis-failure",
      "evidence-storage-full",
      "citation-resolution-failure",
      "partial-citation-failure",
      "cross-question-evidence",
    ]);
    for (const scenario of result.scenarios) {
      const failed = scenario.checks.filter((check) => !check.ok);
      expect(
        failed,
        `${scenario.id} failed: ${failed.map((c) => `${c.name} (expected ${c.expected}, got ${c.actual})`).join("; ")}`,
      ).toEqual([]);
    }
    expect(result.passed).toBe(result.total);
  });

  it("computes the quality gate degradation-honesty score from the suite", () => {
    expect(result.degradationHonesty).toBe(result.passed / result.total);
    expect(result.degradationHonesty).toBe(1);
  });

  it("fails closed on an empty suite and bounds the score at 0..1", () => {
    expect(() => computeDegradationHonesty(0, 0)).toThrow(/at least one scenario/u);
    expect(() => computeDegradationHonesty(2, 1)).toThrow(/outside 0\.\.1/u);
    expect(computeDegradationHonesty(1, 2)).toBe(0.5);
    expect(computeDegradationHonesty(2, 2)).toBe(1);
  });
});
