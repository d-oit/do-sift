/**
 * plugin-search-wikipedia (SRC-06, plan 003): offline tests against
 * recorded response fixtures captured by the SRC-06 spike — no network,
 * no keys (integrate-provider rule 5). The live API shape itself was
 * verified by the spike and is recorded in plans/sources.md.
 */
import { describe, expect, it } from "vitest";
import {
  createWikipediaSearch,
  wikipediaExtractUrl,
  retry429DelayMs,
  SearchProviderError,
  type WikipediaSearchDeps,
} from "../src/index.js";

const TERMS = {
  termsAcceptedAt: "2026-09-14",
  sourcesEntry: "Wikipedia (MediaWiki action API, en.wikipedia.org) — checked 2026-09-14",
};

/** Recorded from the live API by the SRC-06 spike (shape-identical). */
const RECORDED_SEARCH_JSON = {
  batchcomplete: "",
  query: {
    searchinfo: { totalhits: 3210 },
    search: [
      {
        ns: 0,
        title: "SQLite",
        pageid: 12345,
        size: 200000,
        wordcount: 8000,
        snippet:
          'SQLite is a <span class="searchmatch">database</span> engine that implements a self-contained <span class="searchmatch">SQL</span> query engine.',
        timestamp: "2026-01-01T12:00:00Z",
      },
      {
        ns: 0,
        title: "FTS5 Extension",
        pageid: 67890,
        size: 30000,
        wordcount: 2000,
        snippet: 'FTS5 is the <span class="searchmatch">full-text search</span> extension.',
        timestamp: "2025-06-01T00:00:00Z",
      },
    ],
  },
};

const HUGE_SNIPPET_ITEM = {
  ns: 0,
  title: "Big Snippet",
  pageid: 1,
  size: 1,
  wordcount: 1,
  snippet: `<span class="searchmatch">${"x".repeat(6000)}</span>`,
  timestamp: "2025-01-01T00:00:00Z",
};

type FetchLog = { url: string; init?: RequestInit | undefined }[];
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function context(config: unknown, networkHosts: string[] = ["en.wikipedia.org"]) {
  const asserted: string[] = [];
  const ctx = {
    pluginName: "search-wikipedia",
    config,
    events: { emit: () => {} },
    network: {
      assertHostAllowed: (host: string): void => {
        asserted.push(host);
        if (!networkHosts.includes(host)) {
          throw new Error(`host ${host} is not in the manifest networkHosts`);
        }
      },
    },
    secrets: { assertNameAllowed: () => {}, resolve: async () => "" },
    logger: { info: () => {}, warn: () => {} },
  };
  return {
    ctx: ctx as unknown as Parameters<ReturnType<typeof createWikipediaSearch>["activate"]>[0],
    asserted,
  };
}

function deps(fetchLog: FetchLog, responses: Response[], retryCapMs = 1): WikipediaSearchDeps {
  let call = 0;
  return {
    fetchImpl: async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      const res = responses[Math.min(call, responses.length - 1)]!;
      call++;
      return res;
    },
    retryCapMs,
  };
}

describe("activation (terms gate + manifest network host)", () => {
  it("refuses without a recorded terms date and a sources.md entry", async () => {
    const wiki = createWikipediaSearch(deps([], []));
    await expect(wiki.activate(context({ sourcesEntry: "x" }).ctx)).rejects.toThrow(
      /termsAcceptedAt/,
    );
    const wiki2 = createWikipediaSearch(deps([], []));
    await expect(wiki2.activate(context({ termsAcceptedAt: "2026-09-14" }).ctx)).rejects.toThrow(
      /sourcesEntry/,
    );
  });

  it("asserts en.wikipedia.org against the host network service at activation", async () => {
    const wiki = createWikipediaSearch(deps([], []));
    const { ctx } = context({ ...TERMS }, []); // empty networkHosts → assertion must throw
    await expect(wiki.activate(ctx)).rejects.toThrow(/en\.wikipedia\.org/);
    const wiki2 = createWikipediaSearch(deps([], []));
    const ok = context({ ...TERMS });
    await wiki2.activate(ok.ctx);
    expect(ok.asserted).toContain("en.wikipedia.org");
  });
});

describe("search mapping (recorded fixtures)", () => {
  it("maps titles to wiki URLs, strips snippet HTML, ranks in order", async () => {
    const wiki = createWikipediaSearch(deps([], [jsonResponse(RECORDED_SEARCH_JSON)]));
    await wiki.activate(context({ ...TERMS }).ctx);
    const hits = await wiki.search(
      { text: "sqlite database engine", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 10_000 },
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      url: "https://en.wikipedia.org/wiki/SQLite",
      title: "SQLite",
      provider: "wikipedia",
      rank: 0,
    });
    expect(hits[0]?.snippet).toContain("database engine");
    expect(hits[0]?.snippet).not.toContain("<"); // markup stripped at the boundary
    expect(hits[1]?.url).toBe("https://en.wikipedia.org/wiki/FTS5_Extension");
    expect(hits[1]?.rank).toBe(1);
  });

  it("truncates oversized snippets to the contract cap before validation", async () => {
    const wiki = createWikipediaSearch(
      deps([], [jsonResponse({ query: { search: [HUGE_SNIPPET_ITEM] } })]),
    );
    await wiki.activate(context({ ...TERMS }).ctx);
    const hits = await wiki.search(
      { text: "big", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 10_000 },
    );
    expect(hits[0]?.snippet?.length).toBeLessThanOrEqual(4096);
  });

  it("passes srlimit from the contract limits", async () => {
    const log: FetchLog = [];
    const wiki = createWikipediaSearch(deps(log, [jsonResponse(RECORDED_SEARCH_JSON)]));
    await wiki.activate(context({ ...TERMS }).ctx);
    await wiki.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 10_000 });
    expect(log[0]?.url).toContain("srlimit=1");
    expect(log[0]?.url).toContain("action=query");
    expect(log[0]?.url).toContain("formatversion=2");
    expect(log[0]?.init?.headers).toMatchObject({
      "user-agent": expect.stringContaining("do-sift"),
    });
  });

  it("returns [] when the provider reports no results", async () => {
    const wiki = createWikipediaSearch(deps([], [jsonResponse({ query: { search: [] } })]));
    await wiki.activate(context({ ...TERMS }).ctx);
    const hits = await wiki.search(
      { text: "nothing", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 10_000 },
    );
    expect(hits).toEqual([]);
  });
});

describe("error mapping (bounded, polite)", () => {
  it("retries exactly once on 429 with a zero-delay Retry-After, then succeeds", async () => {
    const log: FetchLog = [];
    const wiki = createWikipediaSearch(
      deps(log, [
        jsonResponse({ error: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse(RECORDED_SEARCH_JSON),
      ]),
    );
    await wiki.activate(context({ ...TERMS }).ctx);
    const hits = await wiki.search(
      { text: "q", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 10_000 },
    );
    expect(hits).toHaveLength(2);
    expect(log).toHaveLength(2); // exactly one bounded retry
  });

  it("gives up after one retry when the rate limit persists", async () => {
    const log: FetchLog = [];
    const wiki = createWikipediaSearch(
      deps(log, [
        jsonResponse({}, 429, { "retry-after": "0" }),
        jsonResponse({}, 429, { "retry-after": "0" }),
      ]),
    );
    await wiki.activate(context({ ...TERMS }).ctx);
    await expect(
      wiki.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 10_000 }),
    ).rejects.toThrow(SearchProviderError);
    expect(log).toHaveLength(2);
  });

  it("maps other non-200 responses to a typed error without retrying", async () => {
    const log: FetchLog = [];
    const wiki = createWikipediaSearch(deps(log, [jsonResponse({}, 500)]));
    await wiki.activate(context({ ...TERMS }).ctx);
    await expect(
      wiki.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 10_000 }),
    ).rejects.toThrow(/HTTP 500/);
    expect(log).toHaveLength(1);
  });

  it("maps transport failures (timeout/abort) to a typed error", async () => {
    const wiki = createWikipediaSearch({
      fetchImpl: async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
      retryCapMs: 1,
    });
    await wiki.activate(context({ ...TERMS }).ctx);
    await expect(
      wiki.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 10_000 }),
    ).rejects.toThrow(SearchProviderError);
  });

  it("refuses to search before activation", async () => {
    const wiki = createWikipediaSearch(deps([], []));
    await expect(
      wiki.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 10_000 }),
    ).rejects.toThrow(/not activated/);
  });
});

describe("wikipediaExtractUrl (SRC-07: plain-text content path)", () => {
  it("maps a wiki page URL to the extracts API URL with an encoded title", () => {
    expect(wikipediaExtractUrl("https://en.wikipedia.org/wiki/SQLite")).toBe(
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=SQLite",
    );
    expect(wikipediaExtractUrl("https://en.wikipedia.org/wiki/Fall_of_the_Berlin_Wall")).toBe(
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=Fall_of_the_Berlin_Wall",
    );
  });

  it("decodes percent-encoded slugs and re-encodes the title parameter", () => {
    expect(wikipediaExtractUrl("https://en.wikipedia.org/wiki/What_Happened_to_the_Heart%3F")).toBe(
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=What_Happened_to_the_Heart%3F",
    );
    // %20 → space → back to %20: the API accepts either form
    expect(wikipediaExtractUrl("https://en.wikipedia.org/wiki/A%20B")).toBe(
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=A%20B",
    );
  });

  it("fully encodes hostile titles so query delimiters cannot inject API parameters", () => {
    // A crafted /wiki/ slug whose decoded title contains & and = must come
    // out as one literal titles= value, not extra api.php parameters.
    expect(wikipediaExtractUrl("https://en.wikipedia.org/wiki/A%26action%3Draw%26evil%3D1")).toBe(
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=A%26action%3Draw%26evil%3D1",
    );
  });

  it("returns undefined for anything that is not an en.wikipedia.org wiki page", () => {
    expect(wikipediaExtractUrl("https://evil.test/wiki/X")).toBeUndefined();
    expect(wikipediaExtractUrl("http://en.wikipedia.org/wiki/SQLite")).toBeUndefined();
    expect(wikipediaExtractUrl("https://en.wikipedia.org/w/api.php?action=query")).toBeUndefined();
    expect(wikipediaExtractUrl("not a url")).toBeUndefined();
  });
});

describe("retry429DelayMs (SRC-07 politeness fixes, 2026-09-14 research)", () => {
  it("waits the instructed delay-seconds when it fits the cap", () => {
    expect(retry429DelayMs("3", 5000, 0)).toBe(3000);
    expect(retry429DelayMs("0", 100, 0)).toBe(0);
  });

  it("never retries before the instructed delay — over-cap Retry-After refuses to retry", () => {
    expect(retry429DelayMs("30", 5000, 0)).toBeNull();
  });

  it("parses the HTTP-date form of Retry-After", () => {
    const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(retry429DelayMs("Wed, 21 Oct 2026 07:28:00 GMT", 5000, at - 2000)).toBe(2000);
    expect(retry429DelayMs("Wed, 21 Oct 2026 07:28:00 GMT", 5000, at + 1000)).toBe(0);
  });

  it("applies the 5s etiquette floor when no usable header is present", () => {
    expect(retry429DelayMs(null, 10000, 0)).toBe(5000);
    expect(retry429DelayMs("", 10000, 0)).toBe(5000);
    expect(retry429DelayMs("garbage", 10000, 0)).toBe(5000);
  });

  it("refuses to retry hot when the cap cannot honor the etiquette floor", () => {
    expect(retry429DelayMs(null, 1000, 0)).toBeNull();
  });
});

describe("search 429 politeness (SRC-07)", () => {
  it("fails typed without a second fetch when Retry-After exceeds the cap", async () => {
    const log: FetchLog = [];
    const wiki = createWikipediaSearch(
      deps(log, [jsonResponse({}, 429, { "retry-after": "30" })], 5000),
    );
    await wiki.activate(context({ ...TERMS }).ctx);
    await expect(
      wiki.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 10_000 }),
    ).rejects.toThrow(/rate-limited|Retry-After/);
    expect(log).toHaveLength(1); // no early retry
  });
});
