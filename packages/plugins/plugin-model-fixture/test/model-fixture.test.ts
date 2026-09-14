/**
 * Fixture model provider tests (ANS-02, plan 004). The answer path's first
 * model adapter plugin, deliberately offline: deterministic extractive
 * synthesis with the citation gate satisfied by construction. No real
 * sensors, no network, no billable calls (the full receipt belongs to the
 * dev-signal verification set).
 */
import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import { SynthesisRequest, estimateTokens, type DraftAnswer } from "@do-sift/contracts";
import fixtureJson from "../plugin.json" with { type: "json" };
import { ModelFixtureError, createModelFixture, type ModelFixtureInstance } from "../src/index.js";

function request(overrides: Record<string, unknown> = {}): SynthesisRequest {
  return SynthesisRequest.parse({
    question: "What matters for bm25 ranking quality?",
    passages: [
      { id: "ev-1", text: "bm25 weighting rewards term frequency saturation control." },
      { id: "ev-2", text: "Field length normalization keeps long documents from dominating." },
    ],
    followUps: [],
    maxInputTokens: 4000,
    maxOutputTokens: 700,
    ...overrides,
  });
}

async function activated(
  configOverrides: Record<string, unknown> = {},
): Promise<ModelFixtureInstance> {
  const plugin = createModelFixture();
  await plugin.activate({
    pluginName: "model-fixture",
    config: { ...configOverrides },
    events: { emit: () => {} },
  } as unknown as Parameters<ModelFixtureInstance["activate"]>[0]);
  return plugin;
}

describe("manifest", () => {
  it("declares kind model with zero capabilities", () => {
    expect(fixtureJson.kind).toBe("model");
    expect(fixtureJson.capabilities).toEqual([]);
    expect(fixtureJson.permissions).toEqual({ networkHosts: [], secrets: [] });
  });
});

describe("activation", () => {
  it("activates with defaults when config is empty", async () => {
    const plugin = await activated();
    expect(plugin.modelId).toBe("fixture-extractive-1");
  });

  it("accepts a configured modelId", async () => {
    const plugin = await activated({ modelId: "fixture-extractive-2" });
    expect(plugin.modelId).toBe("fixture-extractive-2");
  });

  it("refuses a non-string modelId", async () => {
    await expect(activated({ modelId: 42 })).rejects.toBeInstanceOf(ModelFixtureError);
  });
});

describe("synthesis", () => {
  it("produces one paragraph block per passage, each citing exactly that passage", async () => {
    const plugin = await activated();
    const draft = await plugin.complete(request());
    expect(draft.blocks).toHaveLength(2);
    expect(draft.blocks[0]?.citations).toEqual(["ev-1"]);
    expect(draft.blocks[1]?.citations).toEqual(["ev-2"]);
    for (const block of draft.blocks) expect(block.kind).toBe("paragraph");
  });

  it("renders passage text verbatim when everything fits the output budget", async () => {
    const plugin = await activated();
    const draft = await plugin.complete(request());
    expect(draft.blocks[0]?.text).toContain("term frequency saturation control");
    expect(draft.blocks[1]?.text).toContain("Field length normalization");
  });

  it("trims output to maxOutputTokens at a word boundary, never empty", async () => {
    const long = "relevance signals compound across ranking stages. ".repeat(120); // ~1200 est tokens
    const plugin = await activated();
    const draft = await plugin.complete(
      request({
        passages: [
          { id: "ev-1", text: long },
          { id: "ev-2", text: long },
          { id: "ev-3", text: long },
        ],
        maxOutputTokens: 700,
      }),
    );
    const total = estimateTokens(draft.blocks.map((b) => b.text).join(" "));
    expect(total).toBeLessThanOrEqual(700);
    expect(draft.blocks.length).toBeGreaterThanOrEqual(1); // never empty
    for (const block of draft.blocks) {
      expect(block.text.trim().length).toBeGreaterThan(0);
      expect(block.text.startsWith("relevance")).toBe(true); // cut at a word boundary
    }
  });

  it("is deterministic: identical requests produce identical drafts", async () => {
    const plugin = await activated();
    const a: DraftAnswer = await plugin.complete(request());
    const b: DraftAnswer = await plugin.complete(request());
    expect(a).toEqual(b);
  });

  it("reports estimated usage attributed to the configured model", async () => {
    const plugin = await activated({ modelId: "fixture-extractive-9" });
    const draft = await plugin.complete(request());
    expect(draft.usage.estimated).toBe(true);
    expect(draft.usage.model).toBe("fixture-extractive-9");
    expect(draft.usage.inputTokens).toBeGreaterThan(0);
    expect(draft.usage.outputTokens).toBeLessThanOrEqual(700);
  });

  it("refuses a pre-aborted call", async () => {
    const plugin = await activated();
    const controller = new AbortController();
    controller.abort();
    await expect(plugin.complete(request(), controller.signal)).rejects.toBeInstanceOf(
      ModelFixtureError,
    );
  });

  it("refuses contract-invalid requests", async () => {
    const plugin = await activated();
    const bad = { ...request(), maxOutputTokens: 100_000 }; // override after the valid parse
    await expect(plugin.complete(bad)).rejects.toThrow(/less than or equal/);
  });
});

describe("kernel round-trip", () => {
  it("registers, activates, completes, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: ModelFixtureInstance | undefined;
    kernel.register({ ...fixtureJson, config: {} }, () => {
      instance = createModelFixture();
      return instance;
    });
    await kernel.activate("model-fixture");
    const draft = await instance?.complete(request());
    expect(draft?.blocks).toHaveLength(2);
    await kernel.deactivate("model-fixture");
    await expect(instance?.complete(request())).rejects.toThrow(/not activated/);
  });
});
