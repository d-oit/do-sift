/**
 * plugin-model-openai-compat (offline slice, 2026-09-21): OpenAI-shaped
 * chat-completions adapter behind the ModelProvider contract. All tests are
 * offline against an injected fetchImpl with recorded response envelopes —
 * no network, no keys (integrate-provider rule 5). No live wiring exists:
 * apps/server config still refuses non-fixture providers.
 */
import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import { SynthesisRequest } from "@do-sift/contracts";
import manifestJson from "../plugin.json" with { type: "json" };
import {
  DRAFT_BLOCKS_JSON_SCHEMA,
  ModelProviderError,
  buildChatBody,
  createOpenAICompatModel,
  type OpenAICompatModelDeps,
  type OpenAICompatModelInstance,
} from "../src/index.js";

const BASE = "https://api.example.test/openai/v1";

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

const GOOD_CONTENT = JSON.stringify({
  blocks: [
    {
      kind: "paragraph",
      text: "bm25 weighting rewards term frequency saturation control.",
      citations: ["ev-1"],
    },
    {
      kind: "paragraph",
      text: "Field length normalization keeps long documents from dominating.",
      citations: ["ev-2"],
    },
  ],
});

function completionEnvelope(content: string, usage?: unknown): Response {
  const body: Record<string, unknown> = {
    id: "chatcmpl-fixture-1",
    object: "chat.completion",
    created: 1758450000,
    model: "probe-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
  if (usage !== undefined) body.usage = usage;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const PROVIDER_USAGE = { prompt_tokens: 412, completion_tokens: 96, total_tokens: 508 };

type FetchLog = { url: string; init?: RequestInit | undefined }[];

function ctx(config: unknown) {
  return {
    pluginName: "model-openai-compat",
    config,
    events: { emit: () => {} },
    network: { assertHostAllowed: () => {} },
    secrets: { assertNameAllowed: () => {}, resolve: async () => "" },
    logger: { info: () => {}, warn: () => {} },
  } as unknown as Parameters<OpenAICompatModelInstance["activate"]>[0];
}

function depsWith(
  fetchLog: FetchLog,
  responses: Response[],
  extra: OpenAICompatModelDeps = {},
): OpenAICompatModelDeps {
  let call = 0;
  return {
    fetchImpl: async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const res = responses[Math.min(call, responses.length - 1)]!;
      call++;
      return res;
    },
    ...extra,
  };
}

async function activated(
  config: unknown,
  deps: OpenAICompatModelDeps = {},
): Promise<OpenAICompatModelInstance> {
  const plugin = createOpenAICompatModel(deps);
  await plugin.activate(ctx(config));
  return plugin;
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { baseURL: BASE, modelId: "probe-model", ...overrides };
}

describe("manifest", () => {
  it("declares kind model with zero capabilities and no preset hosts/secrets", () => {
    expect(manifestJson.kind).toBe("model");
    expect(manifestJson.capabilities).toEqual([]);
    expect(manifestJson.permissions).toEqual({ networkHosts: [], secrets: [] });
  });
});

describe("activation (trusted-operator baseURL gate)", () => {
  it("activates on an https baseURL with defaults", async () => {
    const plugin = await activated(baseConfig());
    expect(plugin.modelId).toBe("probe-model");
  });

  it("refuses a missing baseURL or modelId", async () => {
    await expect(activated({ modelId: "m" })).rejects.toBeInstanceOf(ModelProviderError);
    await expect(activated({ baseURL: BASE })).rejects.toBeInstanceOf(ModelProviderError);
    await expect(activated({ baseURL: "", modelId: "m" })).rejects.toBeInstanceOf(
      ModelProviderError,
    );
  });

  it("refuses non-http(s) schemes", async () => {
    await expect(
      activated(baseConfig({ baseURL: "ftp://models.example.test/v1" })),
    ).rejects.toThrow(/https/);
  });

  it("refuses http for non-loopback hosts but allows loopback http", async () => {
    await expect(
      activated(baseConfig({ baseURL: "http://models.example.test/v1" })),
    ).rejects.toThrow(/loopback/);
    const loopback = await activated(baseConfig({ baseURL: "http://localhost:11434/v1" }));
    expect(loopback.modelId).toBe("probe-model");
    const ipv4 = await activated(baseConfig({ baseURL: "http://127.0.0.1:11434/v1" }));
    expect(ipv4.modelId).toBe("probe-model");
  });

  it("refuses an unknown responseFormat and an empty schemaName", async () => {
    await expect(activated(baseConfig({ responseFormat: "yolo" }))).rejects.toBeInstanceOf(
      ModelProviderError,
    );
    await expect(activated(baseConfig({ schemaName: "  " }))).rejects.toBeInstanceOf(
      ModelProviderError,
    );
  });
});

describe("request mapping (single bounded OpenAI-shaped call)", () => {
  it("posts chat/completions with schema, budget, and no tools field", async () => {
    const log: FetchLog = [];
    const plugin = await activated(
      baseConfig(),
      depsWith(log, [completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE)]),
    );
    await plugin.complete(request());
    expect(log).toHaveLength(1);
    expect(log[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(log[0]?.init?.method).toBe("POST");
    const headers = new Headers(log[0]?.init?.headers);
    expect(headers.get("content-type")).toContain("application/json");
    expect(headers.get("user-agent")).toContain("do-sift/");
    expect(headers.get("authorization")).toBeNull(); // keyless unless the host injects one
    const body = JSON.parse(String(log[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("probe-model");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(700);
    expect(JSON.stringify(body)).not.toContain('"tools"');
    const format = body.response_format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    const schema = format.json_schema as Record<string, unknown>;
    expect(schema.name).toBe("grounded_answer");
    expect(schema.strict).toBe(true);
    expect(schema.schema).toEqual(DRAFT_BLOCKS_JSON_SCHEMA);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("What matters for bm25");
    expect(messages[1]?.content).toContain("[ev-1]");
  });

  it("sends Bearer auth only when the host injects a key (never from config)", async () => {
    const log: FetchLog = [];
    const plugin = await activated(
      baseConfig(),
      depsWith(log, [completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE)], { apiKey: "host-secret" }),
    );
    await plugin.complete(request());
    expect(new Headers(log[0]?.init?.headers).get("authorization")).toBe("Bearer host-secret");
  });

  it("uses best-effort strict:false when configured", async () => {
    const log: FetchLog = [];
    const plugin = await activated(
      baseConfig({ responseFormat: "best-effort" }),
      depsWith(log, [completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE)]),
    );
    await plugin.complete(request());
    const body = JSON.parse(String(log[0]?.init?.body)) as Record<string, unknown>;
    const schema = (body.response_format as Record<string, unknown>).json_schema as Record<
      string,
      unknown
    >;
    expect(schema.strict).toBe(false);
  });
});

describe("response handling", () => {
  it("parses blocks and reconciles provider usage as non-estimated", async () => {
    const plugin = await activated(
      baseConfig(),
      depsWith([], [completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE)]),
    );
    const draft = await plugin.complete(request());
    expect(draft.blocks).toHaveLength(2);
    expect(draft.blocks[0]?.citations).toEqual(["ev-1"]);
    expect(draft.usage).toEqual({
      inputTokens: 412,
      outputTokens: 96,
      model: "probe-model",
      estimated: false,
    });
  });

  it("falls back to estimated usage when the envelope carries no counts", async () => {
    const plugin = await activated(baseConfig(), depsWith([], [completionEnvelope(GOOD_CONTENT)]));
    const draft = await plugin.complete(request());
    expect(draft.usage.estimated).toBe(true);
    expect(draft.usage.model).toBe("probe-model");
    expect(draft.usage.inputTokens).toBeGreaterThan(0);
  });

  it("maps 429 to rate-limited without retrying (one POST total)", async () => {
    const log: FetchLog = [];
    const plugin = await activated(
      baseConfig(),
      depsWith(log, [new Response("Rate limit", { status: 429 })]),
    );
    await expect(plugin.complete(request())).rejects.toMatchObject({ kind: "rate-limited" });
    expect(log).toHaveLength(1);
  });

  it("maps HTTP failures, non-JSON bodies, and empty completions to typed errors", async () => {
    const failing: Response[] = [
      new Response("boom", { status: 500 }),
      new Response("<html>gateway</html>", { status: 200 }),
      completionEnvelope("   "),
      completionEnvelope("not json{{{"),
      completionEnvelope(JSON.stringify({ blocks: "nope" })),
      completionEnvelope(
        JSON.stringify({ blocks: [{ kind: "paragraph", text: "", citations: [] }] }),
      ),
    ];
    for (const res of failing) {
      const plugin = await activated(baseConfig(), depsWith([], [res]));
      await expect(plugin.complete(request())).rejects.toBeInstanceOf(ModelProviderError);
    }
  });

  it("refuses a pre-aborted call and a call before activation", async () => {
    const plugin = await activated(
      baseConfig(),
      depsWith([], [completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE)]),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(plugin.complete(request(), controller.signal)).rejects.toMatchObject({
      kind: "aborted",
    });
    const idle = createOpenAICompatModel(
      depsWith([], [completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE)]),
    );
    await expect(idle.complete(request())).rejects.toThrow(/not activated/);
  });
});

describe("contract drift guards", () => {
  it("constrains only blocks (usage stays host-computed) in a closed schema", () => {
    expect(DRAFT_BLOCKS_JSON_SCHEMA.required).toEqual(["blocks"]);
    expect(DRAFT_BLOCKS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("builds the strict body the success path sends", () => {
    const body = buildChatBody(request(), {
      model: "probe-model",
      schemaName: "grounded_answer",
      mode: "strict",
    });
    expect(body.max_tokens).toBe(700);
    expect(JSON.stringify(body)).not.toContain('"tools"');
  });
});

describe("kernel round-trip", () => {
  it("registers, activates, completes, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: OpenAICompatModelInstance | undefined;
    kernel.register({ ...manifestJson, config: baseConfig() }, () => {
      const plugin = createOpenAICompatModel({
        fetchImpl: async () => completionEnvelope(GOOD_CONTENT, PROVIDER_USAGE),
      });
      instance = plugin;
      return plugin;
    });
    await kernel.activate("model-openai-compat");
    const draft = await instance?.complete(request());
    expect(draft?.blocks).toHaveLength(2);
    await kernel.deactivate("model-openai-compat");
    await expect(instance?.complete(request())).rejects.toThrow(/not activated/);
  });
});
