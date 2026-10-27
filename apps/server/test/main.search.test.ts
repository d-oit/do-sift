/** Merged search composition and the search-health receipt (SRC-16, SRC-17). */
import { describe, expect, it } from "vitest";
import type { DnsResolver, FetchLike } from "@do-sift/safe-fetch";
import { parseEnvConfig, type AppConfig } from "../src/config.js";
import { composeApp } from "../src/main.js";
import { BASE_ENV } from "./main-support.js";
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
