/**
 * plugin-search-marginalia (SRC-15, plan 003): offline tests against
 * recorded response fixtures captured by the SRC-15 spike — no network,
 * no keys (integrate-provider rule 5). The live shape was verified by the
 * spike on 2026-09-15 and is recorded in plans/sources.md; the recorded
 * fixture below is the actual R-16-class response (the Everest-class
 * results the MediaWiki search API structurally never surfaces).
 */
import { describe, expect, it } from "vitest";
import {
  createMarginaliaSearch,
  retry429DelayMs,
  SearchProviderError,
  TermsGateError,
  type MarginaliaSearchDeps,
  pageHtmlToText,
} from "../src/index.js";

const TERMS = {
  termsAcceptedAt: "2026-09-15",
  sourcesEntry: "Marginalia Search (marginalia.nu) — checked 2026-09-15",
};

/** Recorded from the live public API by the SRC-15 spike (shape-identical,
 * subset of the 20-result page; original array indexes preserved so the
 * mapped rank stays the provider's order). */
const RECORDED_SEARCH_JSON = {
  license: "CC-BY-NC-SA 4.0",
  page: 1,
  pages: 11,
  query: "What is the tallest mountain on Earth?",
  results: [
    {
      url: "https://ecuador-travel-guide.com/HighestAndTallestMountain/what-is-the-tallest-mountain-on-earth",
      title: "What is the tallest mountain on Earth?",
      description: "The tallest mountain on Earth is measured from sea level...",
      quality: 3.2,
      format: "html",
      resultsFromDomain: 2,
      details: [],
    },
    {
      url: "https://thehimalayanvoice.blogspot.com/2021/12/is-mount-everest-really-tallest.html",
      title: "IS MOUNT EVEREST REALLY THE TALLEST MOUNTAIN ON EARTH?",
      description: "Mount Everest is the tallest mountain above sea level...",
      quality: 4.1,
      format: "html",
      resultsFromDomain: 1,
      details: [],
    },
    {
      url: "https://www.sciencealert.com/mount-everest-isn-t-really-the-tallest-mountain-earth-science",
      title: "Mount Everest Isn't Really The Tallest Mountain on Earth : ScienceAlert",
      description: "Measured from base to summit, Mauna Kea is taller...",
      quality: 4.4,
      format: "html",
      resultsFromDomain: 1,
      details: [],
    },
    {
      url: "https://en.wikipedia.org/wiki/Tallest_mountain",
      title: "Tallest mountain",
      description: "The tallest mountain or tallest mountain on Earth may refer to...",
      quality: 3.9,
      format: "html",
      resultsFromDomain: 1,
      details: [],
    },
  ],
};

type FetchLog = { url: string; init?: RequestInit | undefined }[];
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function context(config: unknown, networkHosts: string[] = ["api.marginalia.nu"]) {
  const asserted: string[] = [];
  const ctx = {
    pluginName: "search-marginalia",
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
    ctx: ctx as unknown as Parameters<ReturnType<typeof createMarginaliaSearch>["activate"]>[0],
    asserted,
  };
}

function deps(fetchLog: FetchLog, responses: Response[], retryCapMs = 1): MarginaliaSearchDeps {
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
    const plugin = createMarginaliaSearch();
    const { ctx } = context({ termsAcceptedAt: "", sourcesEntry: "" });
    await expect(plugin.activate(ctx)).rejects.toThrow(TermsGateError);
    const { ctx: ctx2 } = context({ termsAcceptedAt: "2026-09-15", sourcesEntry: "" });
    await expect(plugin.activate(ctx2)).rejects.toThrow(TermsGateError);
  });

  it("asserts api.marginalia.nu against the host network service at activation", async () => {
    const plugin = createMarginaliaSearch();
    const { ctx, asserted } = context(TERMS);
    await plugin.activate(ctx);
    expect(asserted).toEqual(["api.marginalia.nu"]);
  });
});

describe("search mapping (recorded fixtures)", () => {
  it("maps the recorded R-16-class response: urls, titles, description snippets, provider-order ranks", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(deps(fetchLog, [jsonResponse(RECORDED_SEARCH_JSON)]));
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);

    const hits = await plugin.search(
      { text: "What is the tallest mountain on Earth?", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 5000 },
    );
    // provider order preserved as rank; the Everest-class page the
    // MediaWiki ranking structurally misses sits at rank 1 here
    expect(hits.map((h) => h.rank)).toEqual([0, 1, 2, 3]);
    expect(hits[1]?.url).toBe(
      "https://thehimalayanvoice.blogspot.com/2021/12/is-mount-everest-really-tallest.html",
    );
    expect(hits[1]?.title).toContain("MOUNT EVEREST");
    expect(hits[1]?.snippet).toContain("tallest mountain above sea level");
    expect(hits.every((h) => h.provider === "marginalia")).toBe(true);
    expect(fetchLog[0]?.url).toBe(
      "https://api.marginalia.nu/public/search/" +
        encodeURIComponent("What is the tallest mountain on Earth?"),
    );
  });

  it("slices to the contract maxHits and skips contract-invalid items honestly", async () => {
    const broken = {
      ...RECORDED_SEARCH_JSON,
      results: [
        {
          url: "not a url at all",
          title: "bad",
          description: "",
          quality: 1,
          format: "html",
          resultsFromDomain: 1,
          details: [],
        },
        ...RECORDED_SEARCH_JSON.results,
      ],
    };
    const plugin = createMarginaliaSearch(deps([], [jsonResponse(broken)]));
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    const hits = await plugin.search(
      { text: "q", ownerId: "owner-a" },
      { maxHits: 2, timeoutMs: 5000 },
    );
    expect(hits).toHaveLength(2); // the invalid item skipped, cap honored
    expect(hits.every((h) => h.rank >= 1)).toBe(true); // original indexes kept
  });

  it("returns [] when the provider reports no results", async () => {
    const plugin = createMarginaliaSearch(
      deps([], [jsonResponse({ ...RECORDED_SEARCH_JSON, results: [] })]),
    );
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    const hits = await plugin.search(
      { text: "obscure", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 5000 },
    );
    expect(hits).toEqual([]);
  });
});

describe("error mapping (bounded, polite)", () => {
  it("retries exactly once on 429 with a zero-delay Retry-After, then succeeds", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(fetchLog, [
        jsonResponse({ error: "QPM Limit Exceeded" }, 429, { "retry-after": "0" }),
        jsonResponse(RECORDED_SEARCH_JSON),
      ]),
    );
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    const hits = await plugin.search(
      { text: "q", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 5000 },
    );
    expect(hits).toHaveLength(4);
    expect(fetchLog).toHaveLength(2);
  });

  it("retries once on 504 (the recorded HTML gateway envelope) and succeeds", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(
        fetchLog,
        [
          new Response("<html><title>504 Gateway Time-out</title>", { status: 504 }),
          jsonResponse(RECORDED_SEARCH_JSON),
        ],
        1000,
      ),
    );
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    const hits = await plugin.search(
      { text: "q", ownerId: "owner-a" },
      { maxHits: 6, timeoutMs: 5000 },
    );
    expect(hits).toHaveLength(4);
    expect(fetchLog).toHaveLength(2);
  });

  it("gives up after the bounded retry when the gateway error persists", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(fetchLog, [new Response("<html>504</html>", { status: 504 })], 1000),
    );
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 5000 }),
    ).rejects.toThrow(/gateway status persisted/);
    expect(fetchLog).toHaveLength(2); // exactly one bounded retry
  });

  it("a cap below the gateway-retry delay means no retry at all (never hot)", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(fetchLog, [new Response("<html>504</html>", { status: 504 })], 1),
    );
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 5000 }),
    ).rejects.toThrow(/gateway status persisted/);
    expect(fetchLog).toHaveLength(1); // no retry — the cap cannot honor the delay
  });

  it("maps a non-JSON 200 body to a typed error (the recorded HTML envelope shape)", async () => {
    const plugin = createMarginaliaSearch(
      deps([], [new Response("<html>unexpected</html>", { status: 200 })]),
    );
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 5000 }),
    ).rejects.toThrow(/non-JSON body/);
  });

  it("maps other non-200 responses and transport failures to typed errors", async () => {
    const plugin = createMarginaliaSearch(deps([], [jsonResponse({}, 500)]));
    const { ctx } = context(TERMS);
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 5000 }),
    ).rejects.toThrow(SearchProviderError);
  });

  it("refuses to search before activation", async () => {
    const plugin = createMarginaliaSearch(deps([], [jsonResponse(RECORDED_SEARCH_JSON)]));
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 6, timeoutMs: 5000 }),
    ).rejects.toThrow(/not activated/);
  });
});

describe("retry429DelayMs (politeness, same discipline as the wikipedia adapter)", () => {
  it("waits the instructed delay-seconds when it fits the cap", () => {
    expect(retry429DelayMs("1", 5000)).toBe(1000);
  });
  it("never retries before the instructed delay — over-cap Retry-After refuses to retry", () => {
    expect(retry429DelayMs("30", 5000)).toBeNull();
  });
  it("parses the HTTP-date form of Retry-After", () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    expect(retry429DelayMs(future, 5000)).toBeLessThanOrEqual(2000);
  });
  it("applies the 5s etiquette floor when no usable header is present", () => {
    expect(retry429DelayMs(null, 5000)).toBe(5000);
  });
  it("refuses to retry hot when the cap cannot honor the etiquette floor", () => {
    expect(retry429DelayMs(null, 1000)).toBeNull();
  });
});

describe("pageHtmlToText (SRC-15 content pre-pass)", () => {
  it("strips tags into block boundaries, drops script/style, decodes entities", () => {
    expect(
      pageHtmlToText(
        "<html><head><style>p{color:red}</style></head><body>" +
          "<h1>Mount Everest</h1>\n<p>It is Earth's highest mountain, 8,848&nbsp;m.</p>" +
          '<script>alert("nope")</script><p>A &amp; B &lt;tag&gt;</p></body></html>',
      ),
    ).toBe("Mount Everest\n\nIt is Earth's highest mountain, 8,848 m.\n\nA & B <tag>");
  });

  it("decodes numeric entities (observed live in the SRC-15 smoke as &#8212;); unpaired surrogates stay literal", () => {
    // out-of-range and unpaired-surrogate codes re-emit as decimal literals
    // (String.fromCodePoint would throw) — textual, never a crash
    expect(pageHtmlToText("<p>a&#8212;b&#x2014;c&#1234567;d&#xD800;e</p>")).toBe(
      "a—b—c&#1234567;d&#55296;e",
    );
  });
});
