/**
 * OPS-05/SRC-06 (plans 005-007, 003-004): the packaged service entrypoint's
 * composition. Wires in one place: local libSQL storage + migrations +
 * owner seed, auth (allowlist + optional loopback dev bypass), the RET-04
 * runtime (research + answer over hybrid retrieval), and the SRC-05 HTTP
 * server.
 *
 * Provider selection is fail-closed and honest (parseEnvConfig): fixture
 * mode is fully synthetic (nothing leaves the process); live mode exists
 * only for terms-gated providers — today Wikipedia, whose fetch path goes
 * through safe-fetch with every hop checked against the site-access policy
 * (exhaustive when DO_SIFT_FETCH_ALLOWLIST is set).
 */
import { createClient, type Client } from "@libsql/client";
import { AuthService, StaticOidcVerifier } from "@do-sift/auth";
import type { SearchProvider } from "@do-sift/contracts";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import { createReadabilityExtractor } from "@do-sift/plugin-extract-readability";
import type { PageContent } from "@do-sift/plugin-harness-research";
import { createMarginaliaSearch, pageHtmlToText } from "@do-sift/plugin-search-marginalia";
import { createSiteAccessPolicy } from "@do-sift/plugin-policy-siteaccess";
import {
  createWikipediaSearch,
  USER_AGENT,
  wikipediaExtractUrl,
} from "@do-sift/plugin-search-wikipedia";
import { safeFetch, type DnsResolver, type FetchLike } from "@do-sift/safe-fetch";
import {
  createMergedSearchProvider,
  createResearchServer,
  createRuntime,
  listen,
  type ResearchRunOutcome,
  type Runtime,
} from "@do-sift/server";
import {
  applyMigrations,
  createFastEmbedEmbedder,
  loadMigrations,
  Repositories,
  type TextEmbedder,
} from "@do-sift/storage";
import { lookup as dnsLookup } from "node:dns/promises";
import { parseEnvConfig, type AppConfig } from "./config.js";

// The policy treats apps/ like plugin territory: no raw node:http import.
// The server type comes from the factory's return type instead.
type HttpServer = ReturnType<typeof createResearchServer>;

/** Production resolver: every address goes through safe-fetch's guards. */
const realDns: DnsResolver = {
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
};

/** Synthetic pages for fixture mode: .test hosts are reserved and never resolve. */
const FIXTURE_PAGES: Record<string, { title: string; text: string }> = {
  "https://docs.test/fts5": {
    title: "FTS5 notes",
    text: [
      "FTS5 is SQLite's virtual table module for full-text search.",
      "FTS5 ranks keyword matches with bm25, where lower scores are better.",
      "The bm25 function weighs rarer terms more heavily in the ranking, so distinctive words dominate the score.",
      "Prefix queries and the highlight() helper make FTS5 convenient for ad-hoc search interfaces.",
    ].join("\n\n"),
  },
  "https://guide.test/hybrid": {
    title: "Hybrid retrieval notes",
    text: [
      "Hybrid retrieval fuses lexical and dense rankings with reciprocal rank fusion.",
      "Dense retrieval embeds passages into vectors and compares cosine similarity.",
      "Fusion helps paraphrase queries that share little lexical overlap with the corpus.",
    ].join("\n\n"),
  },
};

const FIXTURE_SEARCH_HITS = [
  { url: "https://docs.test/fts5", title: "FTS5 notes", snippet: "fts5 bm25 ranking", rank: 0 },
  {
    url: "https://guide.test/hybrid",
    title: "Hybrid retrieval notes",
    snippet: "hybrid retrieval fusion",
    rank: 1,
  },
];

/** The dated plans/sources.md entry that clears the live Wikipedia source. */
const WIKIPEDIA_TERMS = {
  termsAcceptedAt: "2026-09-14",
  sourcesEntry: "Wikipedia (MediaWiki action API, en.wikipedia.org) — checked 2026-09-14",
};

/** The dated plans/sources.md entry that clears the live Marginalia source (SRC-15). */
const MARGINALIA_TERMS = {
  termsAcceptedAt: "2026-09-15",
  sourcesEntry: "Marginalia Search (marginalia.nu) — checked 2026-09-15",
};

export interface ComposeDeps {
  /** Test seam: overrides config.dbUrl (e.g. ":memory:" for hermetic tests). */
  dbUrl?: string;
  /**
   * Test seam: overrides config.port. Windows quirk: re-binding the same
   * fixed port back-to-back after close() can reset connections
   * (SO_REUSEADDR double-bind), so hermetic tests pass 0 (ephemeral).
   */
  port?: number;
  /** Test seam: fetch used by live mode (search adapter + safe-fetch). */
  fetchImpl?: FetchLike | undefined;
  /** Test seam: DNS resolver for safe-fetch (tests stay hermetic). */
  dns?: DnsResolver | undefined;
}

export interface ComposedApp {
  config: AppConfig;
  server: HttpServer;
  runtime: Runtime;
  repositories: Repositories;
  client: Client;
  /** Bound port (the listen() result). */
  port: number;
  close(): Promise<void>;
}

export async function composeApp(config: AppConfig, deps: ComposeDeps = {}): Promise<ComposedApp> {
  const client = createClient({ url: deps.dbUrl ?? config.dbUrl });
  const repositories = new Repositories(client);
  await applyMigrations(client, loadMigrations(config.migrationsDir));
  for (const owner of config.owners) {
    await repositories.owners.ensure(owner, owner);
  }

  // Site-access policy governs every live fetch (exhaustive when the
  // operator allowlist is set; the shipped deny list stays absolute).
  const siteAccess = createSiteAccessPolicy();
  await siteAccess.activate({
    events: { emit: () => {} },
    config: { allowlist: config.fetchAllowlist },
  } as unknown as Parameters<typeof siteAccess.activate>[0]);

  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  let search: SearchProvider;
  let fetchPage: (fetchUrl: string) => Promise<PageContent>;
  let extract: ((text: string) => Array<{ text: string; status: "ok" | "partial" }>) | undefined;

  if (config.searchProviders[0] === "fixture") {
    search = new FakeSearchProvider({ hits: FIXTURE_SEARCH_HITS });
    fetchPage = async (fetchUrl) => {
      const page = FIXTURE_PAGES[fetchUrl];
      if (page === undefined) {
        throw new Error(`fixture page store has no page for ${fetchUrl}`);
      }
      return { text: page.text, contentType: "text/html" };
    };
  } else {
    // Live mode: terms-gated adapters plus the real fetch path —
    // safe-fetch (scheme/IP/redirect/DNS/size/time/MIME guards) with every
    // hop checked against the site-access policy. The same policy backs
    // the adapters' manifest-host assertions in this host-direct
    // composition. SRC-16: multiple providers compose into ONE merged
    // provider (fan-out + interleave + dedup) so both recall bases feed
    // every run.
    const liveAdapters: SearchProvider[] = [];
    for (const choice of config.searchProviders) {
      if (choice === "marginalia") {
        // SRC-15: the second keyless provider (R-16 structural lever).
        const marginalia = createMarginaliaSearch({ fetchImpl });
        await marginalia.activate({
          events: { emit: () => {} },
          pluginName: "search-marginalia",
          config: { ...MARGINALIA_TERMS },
          network: { assertHostAllowed: (host: string) => siteAccess.assertAllowed(host) },
        } as unknown as Parameters<typeof marginalia.activate>[0]);
        liveAdapters.push(marginalia);
      } else if (choice === "wikipedia") {
        const wikipedia = createWikipediaSearch({ fetchImpl });
        await wikipedia.activate({
          events: { emit: () => {} },
          pluginName: "search-wikipedia",
          config: { ...WIKIPEDIA_TERMS },
          network: { assertHostAllowed: (host: string) => siteAccess.assertAllowed(host) },
        } as unknown as Parameters<typeof wikipedia.activate>[0]);
        liveAdapters.push(wikipedia);
      }
    }
    search =
      liveAdapters.length === 1
        ? liveAdapters[0]!
        : createMergedSearchProvider(liveAdapters as [SearchProvider, SearchProvider]);

    // SRC-03 extraction: readability over fetched HTML (offline plugin).
    const readability = createReadabilityExtractor();
    await readability.activate({
      pluginName: "extract-readability",
      kind: "extractor",
      config: {},
      logger: { info: () => {}, warn: () => {} },
      network: {
        assertHostAllowed: (host: string) => {
          throw new Error(`extract-readability must not fetch (asked for ${host})`);
        },
      },
      secrets: { assertNameAllowed: () => {}, resolve: async () => "" },
      events: { emit: () => {} },
    } as unknown as Parameters<typeof readability.activate>[0]);
    extract = (text) => readability.extract(text);

    const dns: DnsResolver = deps.dns ?? realDns;
    const wikiInComposition = config.searchProviders.includes("wikipedia");
    fetchPage = async (fetchUrl) => {
      // SRC-16: DUAL content path per hit URL. A wiki URL in a composition
      // that includes wikipedia maps to the plain-text extract endpoint
      // (SRC-07 — no HTML-stripping pipeline for wiki pages); anything
      // else goes through the generic safe-fetch path with the SRC-15
      // pre-pass (marginalia hits are arbitrary web URLs — the SRC-06
      // general live-fetch path, every hop site-access-checked).
      const extractApiUrl = wikiInComposition ? wikipediaExtractUrl(fetchUrl) : undefined;
      if (extractApiUrl === undefined) {
        if (wikiInComposition && config.searchProviders.length === 1) {
          throw new Error(`unsupported content url in wikipedia mode: ${fetchUrl}`);
        }
        const result = await safeFetch(fetchUrl, {
          maxBytes: 2_000_000,
          timeoutMs: 10_000,
          maxRedirects: 3,
          headers: { "user-agent": USER_AGENT },
          dns,
          fetchImpl,
          checkHost: (host) => siteAccess.assertAllowed(host),
        });
        // SRC-15: HTML → text pre-pass (plugin-owned) before the
        // text-block readability extractor — raw markup must not reach
        // stored passages (F1 lesson). The extractor still runs on the
        // result via the shared live-mode wiring.
        return { text: pageHtmlToText(result.text), contentType: "text/plain" };
      }
      // SRC-07: content comes from the plain-text extract endpoint — no
      // HTML stripping pipeline exists, so template metadata cannot leak
      // into passages (QUAL run-001 finding F1). Same guards, same host.
      const result = await safeFetch(extractApiUrl, {
        maxBytes: 2_000_000,
        timeoutMs: 10_000,
        maxRedirects: 3,
        // The 2026 Wikimedia UA policy: descriptive UA on all requests;
        // Node's generic default is block-eligible and lands in the
        // 10 req/min unidentified rate class instead of 200 req/min.
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        dns,
        fetchImpl,
        checkHost: (host) => siteAccess.assertAllowed(host),
      });
      // formatversion=2 (SRC-09): query.pages is an ARRAY. The v1 map
      // shape is tolerated for robustness, but the expected shape is v2.
      const body = JSON.parse(result.text) as {
        query?: {
          pages?: Record<string, { extract?: unknown }> | Array<{ extract?: unknown }>;
        };
      };
      const pages = body.query?.pages;
      const page = Array.isArray(pages) ? pages[0] : Object.values(pages ?? {})[0];
      const extract = page?.extract;
      if (typeof extract !== "string" || extract === "") {
        throw new Error(`no plain-text extract returned for ${fetchUrl}`);
      }
      // SRC-08: explaintext keeps wikitext-style heading markers
      // ("== Early life and education ==" — observed verbatim in the
      // QUAL run-002/003 captures). Drop standalone heading-marker
      // lines — a bare heading fragment is itself the noise class the
      // QUAL scorecard penalizes — and collapse the runs they leave.
      // Prose never starts a line with '==', so a single '=' in text
      // survives.
      const prose = extract
        .split("\n")
        .filter((line) => !/^={2,}\s*[^=].*={2,}$/u.test(line.trim()))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return { text: prose, contentType: "text/plain" };
    };
  }

  let embedder: TextEmbedder | undefined;
  if (config.embedder === "fastembed") {
    embedder = await createFastEmbedEmbedder();
  }

  const model = config.modelProvider === "fixture" ? new FakeModelProvider() : undefined;

  const runtime = await createRuntime({
    client,
    search,
    fetchPage,
    ...(extract === undefined ? {} : { extract }),
    ...(model === undefined ? {} : { model }),
    ...(embedder === undefined ? {} : { embedder }),
  });

  const auth = new AuthService(
    // Empty token map: bearer tokens refuse until a real OIDC verifier
    // lands (sources.md gate); the loopback dev bypass is the dev path.
    new StaticOidcVerifier({}),
    {
      allowlist: config.owners,
      devBypass: config.devBypass,
      ...(config.devOwner === undefined ? {} : { devOwner: config.devOwner }),
    },
  );

  const server = createResearchServer({
    auth,
    runResearch: (ownerId, question, onSource): Promise<ResearchRunOutcome> =>
      runtime.runResearch(ownerId, question, onSource),
    ...(model === undefined
      ? {}
      : {
          answer: (ownerId: string, question: string) => runtime.answerResponse(ownerId, question),
        }),
  });

  const port = await listen(server, config.host, deps.port ?? config.port);

  return {
    config,
    server,
    runtime,
    repositories,
    client,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.close();
    },
  };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = parseEnvConfig(env);
  const app = await composeApp(config);

  console.log(`do-sift listening on http://${config.host}:${app.port}`);
  console.log(
    `  db: ${config.dbUrl} (migrations: ${config.migrationsDir}); owners: ${config.owners.length} allowlisted; dev bypass: ${config.devBypass ? "ON (loopback-only)" : "off"}`,
  );
  const providersLabel = config.searchProviders.join("+");
  const compositionLabel =
    config.searchProviders.length > 1 ? `merged/${providersLabel}` : providersLabel;
  const searchLabel =
    config.searchProviders[0] === "fixture"
      ? "fixture (synthetic, dev only)"
      : `${compositionLabel} (live — result metadata CC BY-SA (wikipedia) / CC BY-NC-SA (marginalia), attribution preserved; fetch allowlist: ${config.fetchAllowlist.length > 0 ? config.fetchAllowlist.join(",") : "default posture"})`;
  console.log(
    `  search: ${searchLabel} | model: ${config.modelProvider === undefined ? "not configured (/api/answer → 501)" : "fixture (synthetic, dev only)"} | embedder: ${config.embedder ?? "keyword-only"}`,
  );
  console.log("  budget: no caps configured (fixture/live-search mode makes no billable calls)");

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
