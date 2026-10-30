/** Manifest, trusted-operator baseURL gate, and request mapping (single bounded OpenAI-shaped call). */
import { describe, expect, it } from "vitest";
import manifestJson from "../plugin.json" with { type: "json" };
import { DRAFT_BLOCKS_JSON_SCHEMA, ModelProviderError } from "../src/index.js";
import {
  BASE,
  request,
  GOOD_CONTENT,
  completionEnvelope,
  PROVIDER_USAGE,
  type FetchLog,
  depsWith,
  activated,
  baseConfig,
} from "./openai-compat-support.js";
describe("manifest", () => {
  it("declares kind model with only the network capability and no preset hosts/secrets", () => {
    expect(manifestJson.kind).toBe("model");
    expect(manifestJson.capabilities).toEqual(["network"]);
    expect(manifestJson.permissions).toEqual({ networkHosts: [], secrets: [] });
  });
});

describe("activation (trusted-operator baseURL gate)", () => {
  it("activates on an https baseURL with defaults", async () => {
    const plugin = await activated(baseConfig());
    expect(plugin.modelId).toBe("probe-model");
    expect(plugin.name).toBe("openai-compat");
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

  it("refuses without a recorded terms date and a sources.md entry", async () => {
    await expect(activated(baseConfig({ termsAcceptedAt: "" }))).rejects.toThrow(/termsAcceptedAt/);
    await expect(activated(baseConfig({ sourcesEntry: "  " }))).rejects.toThrow(/sourcesEntry/);
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
    expect(headers.get("user-agent")).toContain("https://github.com/d-oit/do-sift");
    expect(headers.get("authorization")).toBeNull(); // keyless unless the host injects one
    const body = JSON.parse(String(log[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("probe-model");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(700);
    expect(body.max_completion_tokens).toBe(700);
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
    // ANS-11: evidence arrives as one JSON record per line, not `[id] text`.
    expect(messages[1]?.content).toContain('"id":"ev-1"');
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
