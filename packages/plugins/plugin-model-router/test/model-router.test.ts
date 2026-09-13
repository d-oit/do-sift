import { describe, expect, it } from "vitest";
import { SynthesisRequest } from "@do-sift/contracts";
import { FakeModelProvider } from "@do-sift/fake-providers";
import { Kernel } from "@do-sift/kernel";
import routerJson from "../plugin.json" with { type: "json" };
import {
  ModelRouterError,
  createModelRouter,
  estimateCostMicroUsd,
  type ModelRouterInstance,
  type RouterProvider,
} from "../src/index.js";

const REQUEST = SynthesisRequest.parse({
  question: "What is X?",
  passages: [{ id: "ev-1", text: "X is a thing documented here." }],
  maxInputTokens: 4000,
  maxOutputTokens: 700,
});

function providers(): RouterProvider[] {
  return [
    { name: "fixture-free", provider: new FakeModelProvider({ modelId: "fixture-1" }) },
    {
      name: "paid-unverified",
      provider: new FakeModelProvider({ modelId: "paid-1" }),
      paid: true,
    },
    {
      name: "paid-verified",
      provider: new FakeModelProvider({ modelId: "paid-2" }),
      paid: true,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
      sourcesEntry: "Model providers",
      termsAcceptedAt: "2026-09-10",
    },
  ];
}

function activatedRouter(
  configOverrides: Record<string, unknown> = {},
  injected: RouterProvider[] = providers(),
): ModelRouterInstance {
  const router = createModelRouter({ providers: injected });
  router.activate({
    pluginName: "model-router",
    config: { defaultProvider: "fixture-free", ...configOverrides },
    events: { emit: () => {} },
  } as unknown as Parameters<ModelRouterInstance["activate"]>[0]);
  return router;
}

describe("routing", () => {
  it("delegates to the configured default provider", async () => {
    const router = activatedRouter();
    const draft = await router.complete(REQUEST);
    expect(draft.usage.model).toBe("fixture-1");
    expect(router.selectedProvider).toBe("fixture-free");
    expect(draft.blocks[0]?.citations).toEqual(["ev-1"]); // grounded by the fake
  });

  it("refuses to run before activation and refuses an unconfigured default", async () => {
    await expect(createModelRouter({ providers: providers() }).complete(REQUEST)).rejects.toThrow(
      /not-configured|not activated/,
    );
    const noDefault = createModelRouter({ providers: providers() });
    await expect(
      noDefault.activate({
        pluginName: "model-router",
        config: {},
        events: { emit: () => {} },
      } as unknown as Parameters<ModelRouterInstance["activate"]>[0]),
    ).rejects.toBeInstanceOf(ModelRouterError);
  });

  it("refuses at activation a default that is not an injected provider", async () => {
    const router = createModelRouter({ providers: providers() });
    await expect(
      router.activate({
        pluginName: "model-router",
        config: { defaultProvider: "ghost" },
        events: { emit: () => {} },
      } as unknown as Parameters<ModelRouterInstance["activate"]>[0]),
    ).rejects.toThrow(/unknown-provider/);
  });

  it("honors pre-aborted signals", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(activatedRouter().complete(REQUEST, controller.signal)).rejects.toThrow(/aborted/);
  });
});

describe("paid refusal (D9)", () => {
  it("refuses a paid provider without verified terms metadata", async () => {
    const router = activatedRouter({ defaultProvider: "paid-unverified" });
    await expect(router.complete(REQUEST)).rejects.toMatchObject({ kind: "paid-refused" });
    await expect(router.complete(REQUEST)).rejects.toThrow(/sources\.md/);
  });

  it("refuses a paid provider with terms but without verified pricing", async () => {
    const injected = providers();
    const noPricing = injected.find((p) => p.name === "paid-verified");
    if (noPricing) delete noPricing.pricing;
    const router = activatedRouter({ defaultProvider: "paid-verified" }, injected);
    await expect(router.complete(REQUEST)).rejects.toMatchObject({ kind: "paid-refused" });
  });

  it("allows a paid provider whose sources.md gate and pricing are recorded", async () => {
    const router = activatedRouter({ defaultProvider: "paid-verified" });
    const draft = await router.complete(REQUEST);
    expect(draft.usage.model).toBe("paid-2");
    expect(router.selectedProvider).toBe("paid-verified");
  });
});

describe("cost ceiling", () => {
  it("computes worst-case cost from request ceilings and verified pricing", () => {
    // 4000 in × $3/1M = $0.012; 700 out × $15/1M = $0.0105 → $0.0225 → 22500µUSD
    expect(estimateCostMicroUsd(REQUEST, { inputPer1M: 3, outputPer1M: 15 })).toBe(22500);
  });

  it("refuses calls whose worst case exceeds the ceiling", async () => {
    const router = activatedRouter({
      defaultProvider: "paid-verified",
      maxCostMicroUsd: 20_000,
    });
    await expect(router.complete(REQUEST)).rejects.toMatchObject({
      kind: "cost-ceiling-exceeded",
    });
  });

  it("allows calls under the ceiling and free providers without a ceiling", async () => {
    const capped = activatedRouter({
      defaultProvider: "paid-verified",
      maxCostMicroUsd: 25_000,
    });
    await expect(capped.complete(REQUEST)).resolves.toMatchObject({
      usage: { model: "paid-2" },
    });

    const free = activatedRouter({ maxCostMicroUsd: 1 });
    await expect(free.complete(REQUEST)).resolves.toBeDefined(); // free: no pricing check needed
  });
});

describe("zero-capability proof + kernel round-trip", () => {
  it("declares no capabilities (providers own theirs)", () => {
    expect(routerJson.capabilities).toEqual([]);
    expect(routerJson.kind).toBe("model");
  });

  it("registers, activates, completes, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: ModelRouterInstance | undefined;
    kernel.register({ ...routerJson, config: { defaultProvider: "fixture-free" } }, () => {
      instance = createModelRouter({ providers: providers() });
      return instance;
    });
    await kernel.activate("model-router");
    const draft = await instance?.complete(REQUEST);
    expect(draft?.usage.model).toBe("fixture-1");
    await kernel.deactivate("model-router");
    await expect(instance?.complete(REQUEST)).rejects.toThrow(/not activated/);
  });
});
