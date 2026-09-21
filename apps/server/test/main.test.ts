/**
 * OPS-05 (plan 005-007): the packaged server entrypoint. Red-first tests:
 * `parseEnvConfig` is a pure env → config matrix with fail-closed rules;
 * `composeApp` is the whole composition driven over real HTTP with fixture
 * providers on an in-memory DB (offline, deterministic — 0 network,
 * 0 model calls). The fixture providers are LOUDLY synthetic: the entrypoint
 * refuses to start without an explicit provider choice, and fixture mode is
 * a labeled dev posture, never a silent default.
 */
import { describe, expect, it } from "vitest";
import type { DnsResolver, FetchLike } from "@do-sift/safe-fetch";
import { parseEnvConfig, type AppConfig } from "../src/config.js";
import { composeApp, type ComposedApp } from "../src/main.js";

const BASE_ENV: Record<string, string> = {
  DO_SIFT_OWNERS: "owner-a",
  DO_SIFT_SEARCH_PROVIDER: "fixture",
};

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

describe("composeApp (fixture mode, offline end-to-end)", () => {
  async function start(env: Record<string, string>): Promise<ComposedApp> {
    const config: AppConfig = parseEnvConfig({ ...BASE_ENV, ...env });
    // Test seams: :memory: keeps the suite hermetic; port 0 avoids the
    // Windows same-port re-bind reset between tests.
    return composeApp(config, { dbUrl: ":memory:", port: 0 });
  }

  it("serves /healthz unauthenticated, research SSE, and grounded answers with the fixture model", async () => {
    const app = await start({
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
    });
    try {
      const base = `http://127.0.0.1:${app.port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does fts5 ranking work?" }),
      });
      expect(research.status).toBe(200);
      const sse = await research.text();
      expect(sse).toContain("event: source");
      expect(sse).toContain("event: done");
      expect(sse).toContain('"documentsStored":2');

      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does fts5 ranking work?" }),
      });
      expect(answer.status).toBe(200);
      const payload = (await answer.json()) as {
        evidenceOnly: boolean;
        degraded: boolean;
        blocks: Array<{ kind: string; text: string; citations: string[] }>;
      };
      expect(payload.evidenceOnly).toBe(false);
      expect(payload.degraded).toBe(false);
      expect(payload.blocks.length).toBeGreaterThan(0);
      for (const block of payload.blocks) {
        expect(block.citations.length).toBeGreaterThan(0); // citations resolve to stored evidence
      }
    } finally {
      await app.close();
    }
  });

  it("without a configured model the answer route answers 501 honestly while research still works", async () => {
    const app = await start({ DO_SIFT_DEV_BYPASS: "1", DO_SIFT_DEV_OWNER: "owner-a" });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "anything" }),
      });
      expect(answer.status).toBe(501);
      expect(((await answer.json()) as { error: string }).error).toContain(
        "answer surface not configured",
      );

      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does fts5 ranking work?" }),
      });
      expect(research.status).toBe(200); // search mode = zero LLM calls
      expect(await research.text()).toContain("event: done");
    } finally {
      await app.close();
    }
  });

  it("seeds every allowlisted owner into the owners registry at startup", async () => {
    const app = await start({ DO_SIFT_OWNERS: "owner-a, owner-b" });
    try {
      expect((await app.repositories.owners.get("owner-a"))?.id).toBe("owner-a");
      expect((await app.repositories.owners.get("owner-b"))?.id).toBe("owner-b");
    } finally {
      await app.close();
    }
  });
});

describe("composeApp wikipedia mode (live path, hermetic via fetch/dns seams)", () => {
  /** Shape recorded from the live API by the SRC-06 spike. */
  const RECORDED_SEARCH = {
    query: {
      search: [
        {
          ns: 0,
          title: "SQLite",
          pageid: 1,
          size: 1,
          wordcount: 1,
          snippet: 'SQLite is a <span class="searchmatch">database</span> engine.',
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    },
  };
  /** v2 shape (SRC-09): formatversion=2 makes query.pages an ARRAY. */
  const RECORDED_EXTRACT = {
    query: {
      pages: [
        {
          pageid: 1,
          ns: 0,
          title: "SQLite",
          extract:
            "SQLite embeds the whole database in a single portable file.\n\nThe FTS5 extension ranks keyword matches with bm25 scoring.",
        },
      ],
    },
  };

  it("runs research through the live adapter + safe-fetch path and answers from stored evidence", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org",
    });
    let searchCalls = 0;
    let extractInit: RequestInit | undefined;
    let extractUrl = "";
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("prop=extracts")) {
        extractInit = init;
        extractUrl = url;
        return new Response(JSON.stringify(RECORDED_EXTRACT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("list=search")) {
        searchCalls++;
        return new Response(JSON.stringify(RECORDED_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`stub fetch got an unexpected url: ${url}`);
    };
    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };
    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;

      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      expect(research.status).toBe(200);
      const sse = await research.text();
      expect(sse).toContain("event: source");
      expect(sse).toContain("event: done");
      expect(sse).toContain('"documentsStored":1');
      expect(searchCalls).toBe(1);
      // Wikimedia UA policy (2026-09-14 research): the content fetch must
      // carry the descriptive adapter User-Agent, never a generic default.
      expect(extractInit?.headers).toMatchObject({
        "user-agent": expect.stringContaining("do-sift"),
      });
      // SRC-09: officially recommended formatversion=2 on API calls.
      expect(extractUrl).toContain("formatversion=2");

      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      expect(answer.status).toBe(200);
      const payload = (await answer.json()) as {
        evidenceOnly: boolean;
        blocks: Array<{ text: string; citations: string[] }>;
      };
      expect(payload.evidenceOnly).toBe(false);
      expect(payload.blocks.length).toBeGreaterThan(0);
      for (const block of payload.blocks) {
        expect(block.citations.length).toBeGreaterThan(0);
        // readability extraction stripped the fetched HTML at the boundary
        expect(block.text).not.toContain("<");
      }
    } finally {
      await app.close();
    }
  });

  it("strips MediaWiki heading-marker lines from extract text before storage (SRC-08)", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org",
    });
    // Shape recorded from live captures (QUAL run-002/003): explaintext
    // keeps wikitext-style heading markers as standalone lines.
    const EXTRACT_WITH_HEADINGS = {
      query: {
        pages: {
          1: {
            pageid: 1,
            ns: 0,
            title: "SQLite",
            extract:
              "== History ==\n\nSQLite was originally written in 2000 by D. Richard Hipp.\n\n=== Design ===\n\nSQLite embeds the whole database in a single portable file.\n\nA single = sign in SQLite prose must survive the pre-pass filter.\n\n    {\\displaystyle a^{2}+b^{2}=c^{2}} appears in SQLite documentation examples.",
          },
        },
      },
    };
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("prop=extracts")) {
        return new Response(JSON.stringify(EXTRACT_WITH_HEADINGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("list=search")) {
        return new Response(JSON.stringify(RECORDED_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`stub fetch got an unexpected url: ${url}`);
    };
    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };
    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite work?" }),
      });
      expect(research.status).toBe(200);
      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite work?" }),
      });
      expect(answer.status).toBe(200);
      const payload = (await answer.json()) as { blocks: Array<{ text: string }> };
      expect(payload.blocks.length).toBeGreaterThan(0);
      for (const block of payload.blocks) {
        // No wikitext heading markers may reach the evidence store.
        expect(block.text).not.toContain("==");
        expect(block.text).not.toMatch(/^=+[^=]*=+$/m);
      }
      const joined = payload.blocks.map((b) => b.text).join("\n");
      expect(joined).toContain("portable file"); // real prose stored
      expect(joined).toContain("single = sign"); // single '=' in prose survives
      // TextExtracts quirk (official extension source, 2026-09-14): raw
      // TeX arrives as whitespace-INDENTED {\displaystyle…} lines — the
      // line-start-anchored heading filter must never touch them.
      expect(joined).toContain("displaystyle");
    } finally {
      await app.close();
    }
  });

  it("refuses a redirect to a host outside the exhaustive allowlist (security review fixture)", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
    });
    const fetchedHosts: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      fetchedHosts.push(new URL(url).hostname);
      if (url.includes("list=search")) {
        return new Response(JSON.stringify(RECORDED_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // compromised/captive-network scenario: the trusted page 302s away
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/exfiltrate" },
      });
    };
    const app = await composeApp(config, {
      dbUrl: ":memory:",
      port: 0,
      fetchImpl,
      dns: { lookup: async () => ["93.184.216.34"] },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      const sse = await res.text();
      expect(sse).toContain("event: done");
      expect(sse).toContain('"fetchErrors":1');
      expect(sse).toContain('"documentsStored":0');
      // the off-host hop must never have been requested
      expect(fetchedHosts.every((h) => h === "en.wikipedia.org")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("refuses a redirect to the shipped default-deny list under default posture (security review fixture)", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia",
      // no DO_SIFT_FETCH_ALLOWLIST: default posture, deny list still absolute
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
    });
    const fetchedHosts: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      fetchedHosts.push(new URL(url).hostname);
      if (url.includes("list=search")) {
        return new Response(JSON.stringify(RECORDED_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://www.linkedin.com/uas/login" },
      });
    };
    const app = await composeApp(config, {
      dbUrl: ":memory:",
      port: 0,
      fetchImpl,
      dns: { lookup: async () => ["93.184.216.34"] },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      const sse = await res.text();
      expect(sse).toContain('"fetchErrors":1');
      expect(sse).toContain('"documentsStored":0');
      expect(fetchedHosts.every((h) => h === "en.wikipedia.org")).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("marginalia search provider (SRC-15)", () => {
  it("accepts marginalia as a search provider (terms-checked live adapter)", () => {
    expect(
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "marginalia" }).searchProviders,
    ).toEqual(["marginalia"]);
  });

  it("runs research through the marginalia adapter + the generic safe-fetch page path and answers from stored evidence", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "marginalia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "api.marginalia.nu,tallest-example.test",
    });
    // Shape recorded from the live public API by the SRC-15 spike — the
    // R-16-class response whose rank-1 result is the page MediaWiki never
    // surfaces for this question class.
    const RECORDED_MARGINALIA_SEARCH = {
      license: "CC-BY-NC-SA 4.0",
      page: 1,
      pages: 11,
      query: "What is the tallest mountain on Earth?",
      results: [
        {
          url: "https://tallest-example.test/everest",
          title: "Mount Everest — tallest above sea level",
          description: "Mount Everest is Earth's highest mountain above sea level, 8,848 m.",
          quality: 4.2,
          format: "html",
          resultsFromDomain: 1,
          details: [],
        },
      ],
    };
    const PAGE_HTML =
      "<html><body><h1>Mount Everest</h1>" +
      "<p>Mount Everest is Earth's highest mountain above sea level, at 8,848 metres.</p>" +
      "<p>The summit is the highest point on the Earth's surface.</p></body></html>";
    let pageFetches = 0;
    let searchInit: RequestInit | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith("https://api.marginalia.nu/public/search/")) {
        searchInit = init;
        return new Response(JSON.stringify(RECORDED_MARGINALIA_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://tallest-example.test/everest") {
        pageFetches++;
        return new Response(PAGE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`stub fetch got an unexpected url: ${url}`);
    };
    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };
    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "What is the tallest mountain on Earth?" }),
      });
      expect(research.status).toBe(200);
      const sse = await research.text();
      expect(sse).toContain("event: source");
      expect(sse).toContain('"url":"https://tallest-example.test/everest"');
      expect(sse).toContain("event: done");
      expect(sse).toContain('"documentsStored":1');
      // descriptive UA on the search call (same posture as wikipedia)
      expect(searchInit?.headers).toMatchObject({
        "user-agent": expect.stringContaining("do-sift"),
      });
      expect(pageFetches).toBe(1); // the generic page path fetched the hit URL

      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "What is the tallest mountain on Earth?" }),
      });
      expect(answer.status).toBe(200);
      const payload = (await answer.json()) as {
        evidenceOnly: boolean;
        blocks: Array<{ text: string; citations: string[] }>;
      };
      expect(payload.evidenceOnly).toBe(false);
      expect(payload.blocks.length).toBeGreaterThan(0);
      for (const block of payload.blocks) {
        expect(block.citations.length).toBeGreaterThan(0);
        // readability extraction stripped the fetched HTML at the boundary
        expect(block.text).not.toContain("<");
      }
    } finally {
      await app.close();
    }
  });
});

describe("merged search composition (SRC-16)", () => {
  it("parses a comma list into a priority-ordered provider composition", () => {
    expect(
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "wikipedia,marginalia" })
        .searchProviders,
    ).toEqual(["wikipedia", "marginalia"]);
  });

  it("rejects duplicates and fixture/live mixing in a provider list", () => {
    expect(() =>
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "wikipedia,wikipedia" }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "fixture,wikipedia" }),
    ).toThrow(/cannot mix/);
  });

  it("runs research through BOTH providers and answers from stored evidence of both content paths", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia,marginalia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org,api.marginalia.nu,tallest-example.test",
    });
    const WIKI_SEARCH = {
      query: {
        search: [
          {
            ns: 0,
            title: "SQLite",
            pageid: 1,
            size: 1,
            wordcount: 1,
            snippet: "SQLite is a database engine.",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };
    const WIKI_EXTRACT = {
      query: {
        pages: [
          {
            pageid: 1,
            ns: 0,
            title: "SQLite",
            extract:
              "SQLite embeds the whole database in a single portable file.\n\nThe FTS5 extension ranks keyword matches with bm25 scoring.",
          },
        ],
      },
    };
    const MARGINALIA_SEARCH = {
      license: "CC-BY-NC-SA 4.0",
      page: 1,
      pages: 11,
      query: "how does sqlite fts work?",
      results: [
        {
          url: "https://tallest-example.test/sqlite-alt",
          title: "SQLite explained",
          description: "SQLite ranks keyword matches with bm25 scoring inside FTS5.",
          quality: 4.0,
          format: "html",
          resultsFromDomain: 1,
          details: [],
        },
      ],
    };
    const FOREIGN_HTML =
      "<html><body><h1>SQLite explained</h1>" +
      "<p>SQLite ranks keyword matches with bm25 scoring inside FTS5.</p></body></html>";
    const searched: string[] = [];
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("list=search")) {
        searched.push("wikipedia");
        return new Response(JSON.stringify(WIKI_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.marginalia.nu/public/search/")) {
        searched.push("marginalia");
        return new Response(JSON.stringify(MARGINALIA_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("prop=extracts")) {
        fetched.push("extract:" + url);
        return new Response(JSON.stringify(WIKI_EXTRACT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://tallest-example.test/sqlite-alt") {
        fetched.push("page:" + url);
        return new Response(FOREIGN_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`stub fetch got an unexpected url: ${url}`);
    };
    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };
    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      expect(research.status).toBe(200);
      const sse = await research.text();
      // BOTH providers contributed candidates (the merged pool), and both
      // content paths served their hits: extract endpoint for the wiki
      // URL, generic safe-fetch + pre-pass for the foreign one.
      expect(searched).toEqual(["wikipedia", "marginalia"]);
      expect(sse).toContain('"url":"https://en.wikipedia.org/wiki/SQLite"');
      expect(sse).toContain('"url":"https://tallest-example.test/sqlite-alt"');
      expect(sse).toContain("event: done");
      expect(sse).toContain('"documentsStored":2');
      // SRC-17: the run summary carries per-provider search health
      expect(sse).toContain(
        '"providerHealth":[{"provider":"wikipedia","ok":true},{"provider":"marginalia","ok":true}]',
      );
      expect(fetched).toHaveLength(2);

      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      expect(answer.status).toBe(200);
      const payload = (await answer.json()) as {
        evidenceOnly: boolean;
        blocks: Array<{ text: string; citations: string[] }>;
      };
      expect(payload.evidenceOnly).toBe(false);
      expect(payload.blocks.length).toBeGreaterThan(0);
      for (const block of payload.blocks) {
        expect(block.citations.length).toBeGreaterThan(0);
        expect(block.text).not.toContain("<");
      }
    } finally {
      await app.close();
    }
  });
});

describe("search-health receipt (SRC-17)", () => {
  it("reports a degraded provider in the run summary while the survivor serves the run", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia,marginalia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org,api.marginalia.nu",
    });
    const WIKI_SEARCH = {
      query: {
        search: [
          {
            ns: 0,
            title: "SQLite",
            pageid: 1,
            size: 1,
            wordcount: 1,
            snippet: "SQLite is a database engine.",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };
    const WIKI_EXTRACT = {
      query: {
        pages: [
          {
            pageid: 1,
            ns: 0,
            title: "SQLite",
            extract:
              "SQLite embeds the whole database in a single portable file.\n\nThe FTS5 extension ranks keyword matches with bm25 scoring.",
          },
        ],
      },
    };
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("list=search")) {
        return new Response(JSON.stringify(WIKI_SEARCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("prop=extracts")) {
        return new Response(JSON.stringify(WIKI_EXTRACT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // every marginalia call fails (the recorded run-008-class envelope)
      return new Response("<html>504 Gateway Time-out</html>", { status: 504 });
    };
    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };
    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "how does sqlite fts work?" }),
      });
      expect(research.status).toBe(200);
      const sse = await research.text();
      // the run still succeeds on the survivor (wikipedia), and the health
      // receipt records the marginalia failure with its error — first-class
      // in the measurement, not provenance-only
      expect(sse).toContain("event: done");
      expect(sse).toContain('"documentsStored":1');
      expect(sse).toContain('"providerHealth":[');
      expect(sse).toContain('{"provider":"wikipedia","ok":true}');
      expect(sse).toContain('"provider":"marginalia","ok":false');
      expect(sse).toContain("504");
    } finally {
      await app.close();
    }
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
   * Research never calls it; the first call is always the answer call. */
  function modelSeam(log: ModelLog): { fetchImpl: FetchLike } {
    const fetchImpl: FetchLike = async (url: string, init?: RequestInit) => {
      log.push({ url, init });
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>;
      };
      const content = body.messages?.[1]?.content ?? "";
      const ids = [
        ...new Set([...content.matchAll(/\[([^\]\s]+)\]/gu)].map((m) => m[1] as string)),
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
