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
import { createSiteAccessPolicy } from "@do-sift/plugin-policy-siteaccess";
import { createWikipediaSearch } from "@do-sift/plugin-search-wikipedia";
import { safeFetch, type DnsResolver, type FetchLike } from "@do-sift/safe-fetch";
import {
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

/**
 * Minimal HTML→text for the live fetch path (SRC-06). The readability
 * extractor (SRC-03) is a block heuristic, not a DOM parser, so the host
 * preprocesses: drop script/style/comments, turn block boundaries into
 * paragraph breaks, strip remaining tags, decode the common entities.
 * The result is data — the UI renders it via createTextNode only; this is
 * preprocessing, not a sanitizer.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

  if (config.searchProvider === "fixture") {
    search = new FakeSearchProvider({ hits: FIXTURE_SEARCH_HITS });
    fetchPage = async (fetchUrl) => {
      const page = FIXTURE_PAGES[fetchUrl];
      if (page === undefined) {
        throw new Error(`fixture page store has no page for ${fetchUrl}`);
      }
      return { text: page.text, contentType: "text/html" };
    };
  } else {
    // Live mode: the terms-gated adapter plus the real fetch path —
    // safe-fetch (scheme/IP/redirect/DNS/size/time/MIME guards) with every
    // hop checked against the site-access policy. The same policy backs
    // the adapter's manifest-host assertion in this host-direct composition.
    const wikipedia = createWikipediaSearch({ fetchImpl });
    await wikipedia.activate({
      events: { emit: () => {} },
      pluginName: "search-wikipedia",
      config: { ...WIKIPEDIA_TERMS },
      network: { assertHostAllowed: (host: string) => siteAccess.assertAllowed(host) },
    } as unknown as Parameters<typeof wikipedia.activate>[0]);
    search = wikipedia;

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
    fetchPage = async (fetchUrl) => {
      const result = await safeFetch(fetchUrl, {
        maxBytes: 2_000_000,
        timeoutMs: 10_000,
        maxRedirects: 3,
        dns,
        fetchImpl,
        checkHost: (host) => siteAccess.assertAllowed(host),
      });
      return { text: htmlToText(result.text), contentType: result.contentType };
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
  const searchLabel =
    config.searchProvider === "fixture"
      ? "fixture (synthetic, dev only)"
      : `wikipedia (live — CC BY-SA, attribution preserved; fetch allowlist: ${config.fetchAllowlist.length > 0 ? config.fetchAllowlist.join(",") : "default posture"})`;
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
