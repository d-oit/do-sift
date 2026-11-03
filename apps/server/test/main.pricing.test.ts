/**
 * Model price opt-in at composition (issue #123, plan 038 — EXT-02).
 *
 * The model router's refusal already existed; these tests pin the part that was
 * missing — that `apps/server` actually composes the router, so a deployment
 * cannot reach a billable provider without an explicit paid opt-in, verified
 * pricing, and (when configured) a per-call ceiling.
 */
import { describe, expect, it } from "vitest";
import { parseEnvConfig } from "../src/config.js";
import { usdPer1MToMicroUsd, toSynthesisFailureKind } from "../src/main.js";
import { BASE_ENV } from "./main-support.js";

const OPENAI_ENV = {
  ...BASE_ENV,
  DO_SIFT_MODEL_PROVIDER: "openai-compat",
  DO_SIFT_MODEL_BASE_URL: "https://api.example.test/v1",
  DO_SIFT_MODEL_ID: "test-model",
  DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-11-03",
  DO_SIFT_MODEL_SOURCES_ENTRY: "Model providers — checked 2026-11-03",
  DO_SIFT_BYPASS_LIVE_EVAL_GATE: "1",
};

describe("price opt-in parsing", () => {
  it("defaults to free: no paid flag, no pricing", () => {
    const config = parseEnvConfig(OPENAI_ENV);
    expect(config.modelOpenAI?.paid).toBe(false);
    expect(config.modelOpenAI?.pricing).toBeUndefined();
    expect(config.modelOpenAI?.maxCostMicroUsd).toBeUndefined();
  });

  it("requires both price variables when paid is asserted", () => {
    expect(() => parseEnvConfig({ ...OPENAI_ENV, DO_SIFT_MODEL_PAID: "1" })).toThrow(
      /DO_SIFT_MODEL_PRICE_INPUT_PER_1M/u,
    );
    expect(() =>
      parseEnvConfig({
        ...OPENAI_ENV,
        DO_SIFT_MODEL_PAID: "1",
        DO_SIFT_MODEL_PRICE_INPUT_PER_1M: "3",
      }),
    ).toThrow(/OUTPUT_PER_1M/u);
  });

  it("rejects non-numeric, negative, and non-integer prices instead of defaulting to free", () => {
    const base = { ...OPENAI_ENV, DO_SIFT_MODEL_PAID: "1" };
    expect(() =>
      parseEnvConfig({
        ...base,
        DO_SIFT_MODEL_PRICE_INPUT_PER_1M: "cheap",
        DO_SIFT_MODEL_PRICE_OUTPUT_PER_1M: "15",
      }),
    ).toThrow(/non-negative numbers/u);
    expect(() =>
      parseEnvConfig({
        ...base,
        DO_SIFT_MODEL_PRICE_INPUT_PER_1M: "-1",
        DO_SIFT_MODEL_PRICE_OUTPUT_PER_1M: "15",
      }),
    ).toThrow(/non-negative numbers/u);
    expect(() =>
      parseEnvConfig({
        ...base,
        DO_SIFT_MODEL_PRICE_INPUT_PER_1M: "3",
        DO_SIFT_MODEL_PRICE_OUTPUT_PER_1M: "15",
        DO_SIFT_MODEL_MAX_COST_MICRO_USD: "1.5",
      }),
    ).toThrow(/non-negative integer/u);
  });

  it("accepts a paid provider with verified pricing and a ceiling", () => {
    const config = parseEnvConfig({
      ...OPENAI_ENV,
      DO_SIFT_MODEL_PAID: "1",
      DO_SIFT_MODEL_PRICE_INPUT_PER_1M: "3",
      DO_SIFT_MODEL_PRICE_OUTPUT_PER_1M: "15",
      DO_SIFT_MODEL_MAX_COST_MICRO_USD: "25000",
    });
    expect(config.modelOpenAI?.paid).toBe(true);
    expect(config.modelOpenAI?.pricing).toEqual({ inputPer1M: 3, outputPer1M: 15 });
    expect(config.modelOpenAI?.maxCostMicroUsd).toBe(25000);
  });

  it("accepts zero prices (a free hosted tier recorded explicitly)", () => {
    const config = parseEnvConfig({
      ...OPENAI_ENV,
      DO_SIFT_MODEL_PAID: "1",
      DO_SIFT_MODEL_PRICE_INPUT_PER_1M: "0",
      DO_SIFT_MODEL_PRICE_OUTPUT_PER_1M: "0",
    });
    expect(config.modelOpenAI?.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it("rejects a malformed paid flag rather than treating it as free", () => {
    expect(() => parseEnvConfig({ ...OPENAI_ENV, DO_SIFT_MODEL_PAID: "yes" })).toThrow(
      /DO_SIFT_MODEL_PAID/u,
    );
  });
});

describe("money conversion helpers", () => {
  it("converts USD per 1M to integer micro-USD per 1M", () => {
    expect(usdPer1MToMicroUsd(3)).toBe(3_000_000);
    expect(usdPer1MToMicroUsd(0.15)).toBe(150_000);
    expect(usdPer1MToMicroUsd(0)).toBe(0);
    expect(Number.isInteger(usdPer1MToMicroUsd(0.0000001))).toBe(true);
  });

  it("maps provider failure kinds onto the log's closed enum", () => {
    expect(toSynthesisFailureKind("rate-limited")).toBe("rate-limited");
    expect(toSynthesisFailureKind("timeout")).toBe("timeout");
    expect(toSynthesisFailureKind("aborted")).toBe("aborted");
    expect(toSynthesisFailureKind("http")).toBe("http");
    expect(toSynthesisFailureKind("something-new")).toBe("unknown");
  });
});

describe("search API key config", () => {
  it("carries the secret NAME only when it is set", () => {
    expect(parseEnvConfig({ ...BASE_ENV }).searchApiKeySecret).toBeUndefined();
    expect(
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_API_KEY_SECRET: "  MARGINALIA_API_KEY  " })
        .searchApiKeySecret,
    ).toBe("MARGINALIA_API_KEY");
    expect(
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_API_KEY_SECRET: "   " }).searchApiKeySecret,
    ).toBeUndefined();
  });
});
