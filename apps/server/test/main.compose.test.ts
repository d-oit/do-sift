/** composeApp fixture mode and the marginalia provider over real HTTP with seams (OPS-05, SRC-15); offline and deterministic. */
import { describe, expect, it } from "vitest";
import type { DnsResolver, FetchLike } from "@do-sift/safe-fetch";
import { parseEnvConfig, type AppConfig } from "../src/config.js";
import { composeApp, type ComposedApp } from "../src/main.js";
import { BASE_ENV } from "./main-support.js";
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

      const readiness = await fetch(`${base}/readyz`);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toEqual({ ok: true });

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

  it("concurrent research runs maintain isolated providerHealth receipts when resets/writes interleave", async () => {
    const config: AppConfig = parseEnvConfig({
      ...BASE_ENV,
      DO_SIFT_SEARCH_PROVIDER: "wikipedia,marginalia",
      DO_SIFT_MODEL_PROVIDER: "fixture",
      DO_SIFT_DEV_BYPASS: "1",
      DO_SIFT_DEV_OWNER: "owner-a",
      DO_SIFT_FETCH_ALLOWLIST: "en.wikipedia.org,api.marginalia.nu",
    });
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
            extract: "SQLite embeds the whole database in a single portable file.",
          },
        ],
      },
    };

    const fetchImpl: FetchLike = async (url) => {
      const isRun1 =
        url.includes("question+1") || url.includes("question%201") || url.includes("question1");
      if (url.includes("list=search")) {
        if (isRun1) {
          // Run 1: wikipedia succeeds
          return new Response(JSON.stringify(WIKI_SEARCH), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // Run 2: wikipedia fails
        return new Response("500 Internal Server Error", { status: 500 });
      }
      if (url.includes("prop=extracts")) {
        return new Response(JSON.stringify(WIKI_EXTRACT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.marginalia.nu/")) {
        if (isRun1) {
          // Run 1: marginalia fails after delay (allowing Run 2 to start in parallel)
          await delay(30);
          return new Response("504 Gateway Time-out", { status: 504 });
        }
        // Run 2: marginalia succeeds
        return new Response(
          JSON.stringify({
            license: "CC-BY-NC-SA 4.0",
            page: 1,
            pages: 1,
            query: "test",
            results: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`stub fetch got an unexpected url: ${url}`);
    };

    const dns: DnsResolver = { lookup: async () => ["93.184.216.34"] };
    const app = await composeApp(config, { dbUrl: ":memory:", port: 0, fetchImpl, dns });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const run1Promise = fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "question 1" }),
      });
      // Start run 2 almost immediately so search calls overlap
      await delay(5);
      const run2Promise = fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "question 2" }),
      });

      const [res1, res2] = await Promise.all([run1Promise, run2Promise]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      const sse1 = await res1.text();
      const sse2 = await res2.text();

      // Run 1: wikipedia ok, marginalia failed
      expect(sse1).toContain('{"provider":"wikipedia","ok":true}');
      expect(sse1).toContain('{"provider":"marginalia","ok":false');

      // Run 2: wikipedia failed, marginalia ok
      expect(sse2).toContain('{"provider":"wikipedia","ok":false');
      expect(sse2).toContain('{"provider":"marginalia","ok":true}');
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
        "user-agent": expect.stringContaining("https://github.com/d-oit/do-sift"),
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
