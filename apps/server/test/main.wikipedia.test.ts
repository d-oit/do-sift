/** composeApp wikipedia mode: the live path, kept hermetic through fetch/dns seams (OPS-05). */
import { describe, expect, it } from "vitest";
import type { DnsResolver, FetchLike } from "@do-sift/safe-fetch";
import { parseEnvConfig, type AppConfig } from "../src/config.js";
import { composeApp } from "../src/main.js";
import { BASE_ENV } from "./main-support.js";
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
