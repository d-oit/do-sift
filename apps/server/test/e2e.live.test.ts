/**
 * End-to-end wiring test (issue #123, plan 038 — EXT-04).
 *
 * The live suite (`npm run eval:e2e`, nightly) proves the PROVIDERS. This suite
 * proves the WIRING offline and deterministically, which a nightly-only test
 * cannot: search → evidence stored → retrieval → one synthesis call through the
 * router → citation validation → stored answer → synthesis audit row.
 *
 * It deliberately runs the composed app (`composeApp`) rather than the pieces,
 * so a regression in composition (a router that is built but not used, a log
 * hook that is not attached, a tenant binding that is not forwarded) fails
 * here.
 */
import { describe, expect, it } from "vitest";
import type { DnsResolver, FetchLike } from "@do-sift/safe-fetch";
import {
  SynthesisCallLogService,
  applyMigrations,
  loadMigrations,
  Repositories,
} from "@do-sift/storage";
import { parseEnvConfig } from "../src/config.js";
import { composeApp } from "../src/main.js";
import { BASE_ENV } from "./main-support.js";

const QUESTION = "how does fts5 ranking work?";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("composed end-to-end answer path", () => {
  it("stores evidence from search, synthesizes once, validates citations, and logs the call", async () => {
    const config = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org",
    });

    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("list=search")) {
        return jsonResponse({
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
        });
      }
      if (url.includes("prop=extracts")) {
        // The plain-text extract endpoint (SRC-07 path).
        return sseResponse({
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
        });
      }
      throw new Error(`stub fetch got an unexpected url: ${url}`);
    };
    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };

    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;

      // 1. Search mode (zero LLM calls) stores evidence.
      const research = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: QUESTION }),
      });
      expect(research.status).toBe(200);
      const sse = await research.text();
      expect(sse).toContain("event: source");
      expect(sse).toContain("event: done");

      const repositories = new Repositories(app.client);
      const documents = await repositories.documents.list("owner-a");
      expect(documents.length).toBeGreaterThan(0);
      expect(documents[0]?.canonicalUrl).toContain("en.wikipedia.org");

      const passages = await repositories.passages.listByDocument("owner-a", documents[0]!.id);
      expect(passages.length).toBeGreaterThan(0);
      expect(passages.some((p) => /bm25|FTS5/iu.test(p.excerpt))).toBe(true);

      // 2. Answer mode: one bounded synthesis call, citations validated.
      const answer = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: QUESTION }),
      });
      expect(answer.status).toBe(200);
      const payload = (await answer.json()) as {
        answerId: string;
        evidenceOnly: boolean;
        degraded: boolean;
        blocks: Array<{ citations: string[] }>;
      };
      expect(payload.evidenceOnly).toBe(false);
      expect(payload.degraded).toBe(false);
      expect(payload.blocks.length).toBeGreaterThan(0);
      for (const block of payload.blocks) expect(block.citations.length).toBeGreaterThan(0);

      // 3. The stored answer keeps the citations the model produced.
      const stored = await repositories.answers.get("owner-a", payload.answerId);
      expect(stored).toBeDefined();
      expect(stored?.blocks.length).toBeGreaterThan(0);

      // 4. EXT-03: exactly one synthesis audit row, priced (free fixture = 0).
      const log = new SynthesisCallLogService(app.client);
      const calls = await log.list("owner-a");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.outcome).toBe("completed");
      expect(calls[0]?.totalCostMicroUsd).toBe(0);
      expect(calls[0]?.inputTokens).toBeGreaterThan(0);

      // 5. A repeated question is served from the exact-answer cache: no new
      // synthesis call, so the audit log must not grow.
      const cached = await fetch(`${base}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: QUESTION }),
      });
      expect(cached.status).toBe(200);
      expect(((await cached.json()) as { cached: boolean }).cached).toBe(true);
      expect(await log.list("owner-a")).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("the e2e artifact path is tenant-scoped and append-only", () => {
  it("keeps two tenants' synthesis logs separate in one database", async () => {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: ":memory:" });
    await applyMigrations(client, loadMigrations("migrations"));
    await new Repositories(client, "acme").owners.ensure("owner-a", "A");
    await new Repositories(client, "globex").owners.ensure("owner-a", "A");

    const shared = {
      ownerId: "owner-a",
      provider: "p",
      model: "m",
      estimated: true,
      inputTokens: 1,
      outputTokens: 1,
      priceInputPer1mMicroUsd: 0,
      priceOutputPer1mMicroUsd: 0,
      outcome: "completed" as const,
    };
    await new SynthesisCallLogService(client, "acme").record({ ...shared, tenantId: "acme" });
    await new SynthesisCallLogService(client, "globex").record({ ...shared, tenantId: "globex" });

    expect(await new SynthesisCallLogService(client, "acme").list("owner-a")).toHaveLength(1);
    expect(await new SynthesisCallLogService(client, "globex").list("owner-a")).toHaveLength(1);
    // The same owner id in a third tenant sees nothing.
    expect(await new SynthesisCallLogService(client, "other").list("owner-a")).toEqual([]);
  });
});
