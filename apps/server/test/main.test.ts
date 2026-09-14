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
    expect(config.searchProvider).toBe("fixture");
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
      parseEnvConfig({ ...BASE_ENV, DO_SIFT_SEARCH_PROVIDER: "wikipedia" }).searchProvider,
    ).toBe("wikipedia");
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
  /** Shape recorded from the live plain-text extract endpoint (SRC-07). */
  const RECORDED_EXTRACT = {
    query: {
      pages: {
        1: {
          pageid: 1,
          ns: 0,
          title: "SQLite",
          extract:
            "SQLite embeds the whole database in a single portable file.\n\nThe FTS5 extension ranks keyword matches with bm25 scoring.",
        },
      },
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
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("prop=extracts")) {
        extractInit = init;
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
              "== History ==\n\nSQLite was originally written in 2000 by D. Richard Hipp.\n\n=== Design ===\n\nSQLite embeds the whole database in a single portable file.\n\nA single = sign in SQLite prose must survive the pre-pass filter.",
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
