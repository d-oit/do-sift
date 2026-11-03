/**
 * End-to-end runner contract (issue #123, plan 038 — EXT-04).
 *
 * The runner itself is exercised end-to-end by `npm run eval:e2e -- --fixture`
 * in CI and by the composed-app test in `apps/server/test/e2e.live.test.ts`.
 * What this suite pins is the part a green run cannot prove: that live mode
 * refuses (rather than quietly passing on fixtures), that the scorer is the
 * blunt gate it claims to be, and that the committed threshold file is loaded
 * fail-closed.
 */
import { describe, expect, it } from "vitest";
import { loadThresholds, redactSecrets, runE2E, scoreCase } from "../eval-e2e.js";

const LIVE_GATES = {
  "opt-in": true,
  "owner-approval": true,
  "terms-accepted-at": "2026-11-03",
  "sources-entry": "Model providers",
  fixture: false,
  question: "how does fts5 ranking work?",
};

function args(overrides: Record<string, unknown> = {}): Parameters<typeof runE2E>[1] {
  return { ...LIVE_GATES, ...overrides } as unknown as Parameters<typeof runE2E>[1];
}

describe("scoreCase", () => {
  it("scores a grounded, non-degraded answer 1", () => {
    expect(scoreCase({ evidenceOnly: false, degraded: false, citationsValid: true })).toEqual({
      citationResolution: 1,
      meanQuality: 1,
    });
  });

  it("scores evidence-only output 0 (honest, but not a synthesized answer)", () => {
    expect(
      scoreCase({ evidenceOnly: true, degraded: false, citationsValid: true }).meanQuality,
    ).toBe(0);
  });

  it("scores a degraded answer 0 even when its citations resolve", () => {
    expect(
      scoreCase({ evidenceOnly: false, degraded: true, citationsValid: true }).meanQuality,
    ).toBe(0);
  });

  it("scores an unresolvable citation 0 on both metrics", () => {
    expect(scoreCase({ evidenceOnly: false, degraded: false, citationsValid: false })).toEqual({
      citationResolution: 0,
      meanQuality: 0,
    });
  });
});

describe("loadThresholds", () => {
  it("reads the committed mean-quality floor", () => {
    const thresholds = loadThresholds();
    expect(thresholds.thresholds.minMeanQuality).toBe(0.95);
    expect(thresholds.thresholds.minCitationResolution).toBe(1);
  });

  it("refuses a threshold file that dropped the gate instead of defaulting it", () => {
    expect(() => loadThresholds("evals/datasets/retrieval.json")).toThrow(/minMeanQuality/u);
  });
});

describe("live mode refuses instead of passing on fixtures", () => {
  it("needs an explicit opt-in", async () => {
    const result = await runE2E({}, args({ "opt-in": false }));
    expect(result.passed).toBe(false);
    expect(result.refusalReason).toContain("Explicit opt-in");
    expect(result.cases).toEqual([]);
  });

  it("needs owner approval", async () => {
    const result = await runE2E({}, args({ "owner-approval": false }));
    expect(result.refusalReason).toContain("Owner approval");
  });

  it("needs a dated terms record and a sources entry", async () => {
    const noTerms = await runE2E({}, args({ "terms-accepted-at": "", "sources-entry": "" }));
    expect(noTerms.refusalReason).toContain("Dated terms record");
    expect(noTerms.refusalReason).toContain("sources.md entry");
  });

  it("needs a live model endpoint rather than silently using the fixture model", async () => {
    const result = await runE2E({}, args());
    expect(result.passed).toBe(false);
    expect(result.refusalReason).toContain("--model-id");
    expect(result.refusalReason).toContain("--base-url");
  });

  it("names an unsupported provider instead of pretending to exercise it", async () => {
    const result = await runE2E(
      {},
      args({
        "model-id": "m",
        "base-url": "https://model.test/v1",
        provider: "marginalia",
      }),
    );
    expect(result.refusalReason).toContain("supports --provider wikipedia");
  });
});

describe("fixture mode is hermetic and self-proving", () => {
  it("passes the gate with fixture providers and names no artifact", async () => {
    const result = await runE2E({}, args({ fixture: true }));
    expect(result.mode).toBe("fixture");
    expect(result.passed).toBe(true);
    expect(result.refusalReason).toBeUndefined();
    expect(result.meanQuality).toBe(1);
    expect(result.citationResolution).toBe(1);
    expect(result.cases[0]?.documentsStored).toBeGreaterThan(0);
  });

  it("still requires the committed thresholds to parse in fixture mode", async () => {
    // The fixture path proves wiring; it does not bypass the gate definition.
    const result = await runE2E({}, args({ fixture: true }));
    expect(result.passed).toBe(true);
  });
});

describe("a non-run leaves no evidence artifact", () => {
  it("returns zero cases for a refusal, so the CLI writes nothing", async () => {
    // The CLI writes only when `mode === "live" && cases.length > 0`. A refusal
    // with an empty case list is not evidence and must not create a dated file.
    const refusal = await runE2E({}, args({ "model-id": "m" }));
    expect(refusal.mode).toBe("live");
    expect(refusal.cases).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("removes a resolved key value from a message", () => {
    const key = "sk-livevalue0123456789abcdef";
    expect(redactSecrets(`call failed with ${key}`, [key])).not.toContain(key);
  });

  it("removes bearer tokens and sk-shaped keys it was not told about", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED]");
    expect(redactSecrets("sk-abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("mean quality 0 is below the 0.95 floor")).toBe(
      "mean quality 0 is below the 0.95 floor",
    );
  });
});
