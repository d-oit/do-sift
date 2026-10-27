/** parseEnvConfig matrix and the openai-compat model env (OPS-05): fail-closed env -> config, 0 network, 0 model calls. */
import { describe, expect, it } from "vitest";
import type { FetchLike } from "@do-sift/safe-fetch";
import { parseEnvConfig } from "../src/config.js";
import { composeApp, type ComposedApp } from "../src/main.js";
import { BASE_ENV } from "./main-support.js";
describe("parseEnvConfig", () => {
  it("applies documented defaults for a minimal dev config", () => {
    const config = parseEnvConfig(BASE_ENV);
    expect(config.dbUrl).toBe("file:do-sift.db");
    expect(config.migrationsDir).toBe("migrations");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.owners).toEqual(["owner-a"]);
    expect(config.devBypass).toBe(false);
    expect(config.devOwner).toBeUndefined();
    expect(config.searchProviders).toEqual(["fixture"]);
    expect(config.modelProvider).toBeUndefined();
    expect(config.embedder).toBeUndefined();
    expect(config.fetchAllowlist).toEqual([]);
  });

  it("parses a comma-separated owner allowlist with trimming", () => {
    const config = parseEnvConfig({ ...BASE_ENV, DO_SIFT_OWNERS: " a , b ,c" });
    expect(config.owners).toEqual(["a", "b", "c"]);
  });

  it("refuses to start without an owner allowlist (nobody could authenticate)", () => {
    expect(() => parseEnvConfig({ DO_SIFT_SEARCH_PROVIDER: "fixture" })).toThrow(/DO_SIFT_OWNERS/);
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_OWNERS: " , ," })).toThrow(/DO_SIFT_OWNERS/);
  });

  it("refuses to start without an explicit search provider (fail closed)", () => {
    expect(() => parseEnvConfig({ DO_SIFT_OWNERS: "owner-a" })).toThrow(/DO_SIFT_SEARCH_PROVIDER/);
  });

  it("refuses unknown provider values instead of guessing", () => {
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "tavily" })).toThrow(
      /DO_SIFT_SEARCH_PROVIDER/,
    );
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_MODEL_PROVIDER: "gpt" })).toThrow(
      /DO_SIFT_MODEL_PROVIDER/,
    );
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_EMBEDDER: "openai" })).toThrow(
      /DO_SIFT_EMBEDDER/,
    );
  });

  it("accepts the fixture model and fastembed embedder", () => {
    const config = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_EMBEDDER: "fastembed",
    });
    expect(config.modelProvider).toBe("fixture");
    expect(config.embedder).toBe("fastembed");
  });

  it("refuses remote DB URLs: the Turso path runs through the storage plugin + kernel secrets", () => {
    for (const url of ["libsql://x.turso.io", "https://db.example.com", "wss://db.example.com"]) {
      expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_DB_URL: url })).toThrow(/remote/);
    }
    expect(parseEnvConfig({ ...BASE_ENV, DO_SIFT_DB_URL: ":memory:" }).dbUrl).toBe(":memory:");
  });

  it("gates the dev bypass: needs an owner, loopback-only semantics stay in AuthService", () => {
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_DEV_BYPASS: "1" })).toThrow(
      /DO_SIFT_DEV_OWNER/,
    );
    expect(() =>
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_DEV_BYPASS: "1", DO_SIFT_DEV_OWNER: "ghost" }),
    ).toThrow(/DO_SIFT_OWNERS/);
    const config = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_OWNERS: "owner-a, owner-b",
      DO_SIFT_DEV_BYPASS: "true",
      DO_SIFT_DEV_OWNER: "owner-b",
    });
    expect(config.devBypass).toBe(true);
    expect(config.devOwner).toBe("owner-b");
  });

  it("refuses a dev bypass on a non-loopback bind address", () => {
    expect(() =>
      parseEnvConfig({
        ...BASE_ENV,
        DO_SIFT_DEV_BYPASS: "1",
        DO_SIFT_DEV_OWNER: "owner-a",
        DO_SIFT_HOST: "0.0.0.0",
      }),
    ).toThrow(/loopback/);
  });

  it("also refuses a directly supplied non-loopback dev-bypass composition", async () => {
    const config = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
    });
    await expect(composeApp({ ...config, host: "0.0.0.0" }, { dbUrl: ":memory:" })).rejects.toThrow(
      /loopback/,
    );
  });

  it("rejects a bad dev-bypass value and an out-of-range port", () => {
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_DEV_BYPASS: "yes" })).toThrow(
      /DO_SIFT_DEV_BYPASS/,
    );
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_PORT: "0" })).toThrow(/DO_SIFT_PORT/);
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_PORT: "70000" })).toThrow(/DO_SIFT_PORT/);
    expect(() => parseEnvConfig({ ...BASE_ENV, DO_SIFT_PORT: "http" })).toThrow(/DO_SIFT_PORT/);
    expect(parseEnvConfig({ ...BASE_ENV, DO_SIFT_PORT: "3000" }).port).toBe(3000);
  });

  it("parses the fetch allowlist (exhaustive when set, per the site-access policy)", () => {
    const config = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_FETCH_ALLOWLIST: "example.org, docs.example.org",
    });
    expect(config.fetchAllowlist).toEqual(["example.org", "docs.example.org"]);
  });

  it("accepts wikipedia as a search provider (terms-checked live adapter)", () => {
    expect(
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "wikipedia" }).searchProviders,
    ).toEqual(["wikipedia"]);
  });

  it("accepts openai-compat with baseURL, model, and terms; keyless unless a secret is named", () => {
    const config = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_MODEL_PROVIDER: "openai-compat",
      DO_SIFT_MODEL_BASE_URL: "http://localhost:11434/v1",
      DO_SIFT_MODEL_ID: "probe-model",
      DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
      DO_SIFT_MODEL_SOURCES_ENTRY: "Model providers — candidate, checked 2026-09-21",
    });
    expect(config.modelProvider).toBe("openai-compat");
    expect(config.modelOpenAI).toEqual({
      baseURL: "http://localhost:11434/v1",
      modelId: "probe-model",
      useApiKey: true,
      responseFormat: "strict",
      schemaName: "grounded_answer",
      termsAcceptedAt: "2026-09-21",
      sourcesEntry: "Model providers — candidate, checked 2026-09-21",
    });
  });

  it("parses the key secret name with the use-key kill-switch", () => {
    const keyed = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_MODEL_PROVIDER: "openai-compat",
      DO_SIFT_MODEL_BASE_URL: "https://api.example.test/openai/v1",
      DO_SIFT_MODEL_ID: "probe-model",
      DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
      DO_SIFT_MODEL_SOURCES_ENTRY: "entry",
      DO_SIFT_MODEL_API_KEY_SECRET: "PROBE_API_KEY",
    });
    expect(keyed.modelOpenAI?.apiKeySecret).toBe("PROBE_API_KEY");
    expect(keyed.modelOpenAI?.useApiKey).toBe(true);
    const disabled = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_MODEL_PROVIDER: "openai-compat",
      DO_SIFT_MODEL_BASE_URL: "https://api.example.test/openai/v1",
      DO_SIFT_MODEL_ID: "probe-model",
      DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
      DO_SIFT_MODEL_SOURCES_ENTRY: "entry",
      DO_SIFT_MODEL_API_KEY_SECRET: "PROBE_API_KEY",
      DO_SIFT_MODEL_USE_API_KEY: "0",
    });
    expect(disabled.modelOpenAI?.useApiKey).toBe(false);
    expect(() =>
      parseEnvConfig({
        ...BASE_ENV,
        DO_SIFT_MODEL_PROVIDER: "openai-compat",
        DO_SIFT_MODEL_BASE_URL: "https://api.example.test/openai/v1",
        DO_SIFT_MODEL_ID: "probe-model",
        DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
        DO_SIFT_MODEL_SOURCES_ENTRY: "entry",
        DO_SIFT_MODEL_USE_API_KEY: "maybe",
      }),
    ).toThrow(/DO_SIFT_MODEL_USE_API_KEY/);
    expect(() =>
      parseEnvConfig({
        ...BASE_ENV,
        DO_SIFT_MODEL_PROVIDER: "openai-compat",
        DO_SIFT_MODEL_BASE_URL: "https://api.example.test/openai/v1",
        DO_SIFT_MODEL_ID: "probe-model",
        DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
        DO_SIFT_MODEL_SOURCES_ENTRY: "entry",
        DO_SIFT_MODEL_RESPONSE_FORMAT: "yaml",
      }),
    ).toThrow(/DO_SIFT_MODEL_RESPONSE_FORMAT/);
  });

  it("refuses openai-compat missing baseURL, model, or terms (fail closed)", () => {
    const full = {
      DO_SIFT_MODEL_PROVIDER: "openai-compat",
      DO_SIFT_MODEL_BASE_URL: "http://localhost:11434/v1",
      DO_SIFT_MODEL_ID: "probe-model",
      DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
      DO_SIFT_MODEL_SOURCES_ENTRY: "entry",
    };
    expect(() => parseEnvConfig({ ...BASE_ENV, ...full, DO_SIFT_MODEL_BASE_URL: "" })).toThrow(
      /DO_SIFT_MODEL_BASE_URL/,
    );
    expect(() => parseEnvConfig({ ...BASE_ENV, ...full, DO_SIFT_MODEL_ID: "  " })).toThrow(
      /DO_SIFT_MODEL_ID/,
    );
    expect(() =>
      parseEnvConfig({ ...BASE_ENV, ...full, DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "yesterday" }),
    ).toThrow(/DO_SIFT_MODEL_TERMS_ACCEPTED_AT/);
    expect(() => parseEnvConfig({ ...BASE_ENV, ...full, DO_SIFT_MODEL_SOURCES_ENTRY: "" })).toThrow(
      /DO_SIFT_MODEL_SOURCES_ENTRY/,
    );
  });
});

describe("composeApp openai-compat model (offline end-to-end via seams)", () => {
  const MODEL_ENV: Record<string, string> = {
    DO_SIFT_MODEL_PROVIDER: "openai-compat",
    DO_SIFT_MODEL_BASE_URL: "http://localhost:11434/v1",
    DO_SIFT_MODEL_ID: "probe-model",
    DO_SIFT_MODEL_TERMS_ACCEPTED_AT: "2026-09-21",
    DO_SIFT_MODEL_SOURCES_ENTRY: "Model providers — candidate, checked 2026-09-21",
    DO_SIFT_DEV_BYPASS: "1",
    DO_SIFT_DEV_OWNER: "owner-a",
  };

  type ModelLog = { url: string; init?: RequestInit | undefined }[];

  /** Self-contained stub: echoes the PACKED evidence ids from the incoming
   * request (like the fixture model) so the ANS-03 citation gate passes.
   * Research never calls it; the first call is always the answer call.
   * Since ANS-11 the evidence arrives as one JSON record per line
   * (`{"id":…,"text":…}`), so the stub reads ids from the record fields —
   * the same wire contract the system prompt gives a real model. */
  function modelSeam(log: ModelLog): { fetchImpl: FetchLike } {
    const fetchImpl: FetchLike = async (url: string, init?: RequestInit) => {
      log.push({ url, init });
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>;
      };
      const content = body.messages?.[1]?.content ?? "";
      const ids = [
        ...new Set(
          content.split("\n").flatMap((line) => {
            try {
              const rec = JSON.parse(line) as { id?: unknown };
              return typeof rec.id === "string" ? [rec.id] : [];
            } catch {
              return [];
            }
          }),
        ),
      ].slice(0, 2);
      const envelope = {
        id: "chatcmpl-test-1",
        object: "chat.completion",
        created: 1758450000,
        model: "probe-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                blocks: ids.map((id, i) => ({
                  kind: "paragraph",
                  text: `composed answer block ${i + 1}`,
                  citations: [id],
                })),
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetchImpl };
  }

  async function research(app: ComposedApp): Promise<void> {
    const base = `http://127.0.0.1:${app.port}`;
    const res = await fetch(`${base}/api/research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "how does fts5 ranking work?" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: done");
  }

  async function answerGrounded(app: ComposedApp): Promise<{
    evidenceOnly: boolean;
    blocks: Array<{ text: string; citations: string[] }>;
  }> {
    await research(app);
    const base = `http://127.0.0.1:${app.port}`;
    const res = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "how does fts5 ranking work?" }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      evidenceOnly: boolean;
      blocks: Array<{ text: string; citations: string[] }>;
    };
    expect(payload.evidenceOnly).toBe(false);
    expect(payload.blocks.length).toBeGreaterThan(0);
    for (const block of payload.blocks) expect(block.citations.length).toBeGreaterThan(0);
    return payload;
  }

  function startModel(
    env: Record<string, string>,
    seam: { fetchImpl: FetchLike },
    modelApiKey?: string,
  ): Promise<ComposedApp> {
    const config = parseEnvConfig({ ...BASE_ENV, ...MODEL_ENV, ...env });
    return composeApp(config, {
      dbUrl: ":memory:",
      port: 0,
      fetchImpl: seam.fetchImpl,
      ...(modelApiKey === undefined ? {} : { modelApiKey }),
    });
  }

  it("answers grounded through the wired adapter keyless (no auth header)", async () => {
    const log: ModelLog = [];
    const seam = modelSeam(log);
    const app = await startModel({}, seam);
    try {
      await answerGrounded(app);
      expect(log).toHaveLength(1);
      expect(log[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
      const headers = new Headers(log[0]?.init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("content-type")).toContain("application/json");
    } finally {
      await app.close();
    }
  });

  it("sends Bearer when a key exists and honors the disable switch", async () => {
    const secret = "DO_SIFT_TEST_MODEL_KEY";
    delete process.env[secret];
    // Keyed: secret named + value injected → Bearer sent.
    const keyedLog: ModelLog = [];
    const keyed = modelSeam(keyedLog);
    const keyedApp = await startModel(
      { DO_SIFT_MODEL_API_KEY_SECRET: secret },
      keyed,
      "test-key-value",
    );
    try {
      await answerGrounded(keyedApp);
      expect(new Headers(keyedLog[0]?.init?.headers).get("authorization")).toBe(
        "Bearer test-key-value",
      );
    } finally {
      await keyedApp.close();
    }
    // Disabled: secret named but USE=0 and no value → keyless, no auth header.
    const offLog: ModelLog = [];
    const off = modelSeam(offLog);
    const offApp = await startModel(
      { DO_SIFT_MODEL_API_KEY_SECRET: secret, DO_SIFT_MODEL_USE_API_KEY: "0" },
      off,
    );
    try {
      await answerGrounded(offApp);
      expect(new Headers(offLog[0]?.init?.headers).get("authorization")).toBeNull();
    } finally {
      await offApp.close();
    }
  });

  it("refuses to start when the named secret has no value (no silent keyless)", async () => {
    const secret = "DO_SIFT_TEST_MODEL_KEY_ABSENT";
    delete process.env[secret];
    const log: ModelLog = [];
    const seam = modelSeam(log);
    const config = parseEnvConfig({
      ...BASE_ENV,
      ...MODEL_ENV,
      DO_SIFT_MODEL_API_KEY_SECRET: secret,
    });
    await expect(
      composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl: seam.fetchImpl }),
    ).rejects.toThrow(/DO_SIFT_MODEL_API_KEY_SECRET/);
    expect(log).toHaveLength(0); // refused before any model call
  });
});
