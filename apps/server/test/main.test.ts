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
