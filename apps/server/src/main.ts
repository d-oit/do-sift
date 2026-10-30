/** Packaged server entrypoint (OPS-05): env -> config, then compose the app. Fixtures and composition types live in sibling modules. */
import { createClient } from "@libsql/client";
import {
  AuthService,
  JwksOidcVerifier,
  StaticOidcVerifier,
  isLoopbackAddress,
  type OidcVerifier,
} from "@do-sift/auth";
import type { ModelProvider, SearchProvider } from "@do-sift/contracts";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import { createReadabilityExtractor } from "@do-sift/plugin-extract-readability";
import type { PageContent } from "@do-sift/plugin-harness-research";
import { createOpenAICompatModel } from "@do-sift/plugin-model-openai-compat";
import { createMarginaliaSearch, pageHtmlToText } from "@do-sift/plugin-search-marginalia";
import { createSiteAccessPolicy } from "@do-sift/plugin-policy-siteaccess";
import { USER_AGENT } from "@do-sift/contracts";
import { createWikipediaSearch, wikipediaExtractUrl } from "@do-sift/plugin-search-wikipedia";
import { pinnedFetch, safeFetch, type DnsResolver, type FetchLike } from "@do-sift/safe-fetch";
import {
  MetricsRegistry,
  createMergedSearchProvider,
  createResearchServer,
  createRuntime,
  listen,
  type ResearchRunOutcome,
} from "@do-sift/server";
import {
  applyMigrations,
  createFastEmbedEmbedder,
  loadMigrations,
  Repositories,
  type TextEmbedder,
} from "@do-sift/storage";
import { parseEnvConfig, type AppConfig } from "./config.js";
import type { ComposeDeps, ComposedApp } from "./compose-contracts.js";
import {
  FIXTURE_PAGES,
  FIXTURE_SEARCH_HITS,
  MARGINALIA_TERMS,
  WIKIPEDIA_TERMS,
  modelLabel,
  realDns,
} from "./fixtures.js";
export type { ComposeDeps } from "./compose-contracts.js";
export type { ComposedApp } from "./compose-contracts.js";
export async function composeApp(config: AppConfig, deps: ComposeDeps = {}): Promise<ComposedApp> {
  if (config.devBypass && !isLoopbackAddress(config.host)) {
    throw new Error("dev bypass requires a loopback host; refusing a remotely reachable bypass");
  }
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

  /**
   * SRC-24 (R-11 closure completed for search API calls): the adapters'
   * default transport is pinnedFetch — the same guard pipeline and
   * pinned connect as content fetches, in transport-only mode (the
   * adapters own their 429/502/503/504 envelopes and JSON validation).
   * Hermetic tests injecting deps.fetchImpl delegate unchanged. The
   * 15s backstop sits above the adapters' own 10s envelopes so THEIR
   * timeout mapping (and receipt text) fires first.
   */
  const adapterFetch: FetchLike =
    deps.fetchImpl ??
    pinnedFetch({
      dns: deps.dns ?? realDns,
      checkHost: (host) => siteAccess.assertAllowed(host),
      timeoutMs: 15_000,
    });
  let search: SearchProvider;
  let fetchPage: (fetchUrl: string, signal?: AbortSignal) => Promise<PageContent>;
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
        const marginalia = createMarginaliaSearch({ fetchImpl: adapterFetch });
        await marginalia.activate({
          events: { emit: () => {} },
          pluginName: "search-marginalia",
          config: { ...MARGINALIA_TERMS },
          network: { assertHostAllowed: (host: string) => siteAccess.assertAllowed(host) },
        } as unknown as Parameters<typeof marginalia.activate>[0]);
        liveAdapters.push(marginalia);
      } else if (choice === "wikipedia") {
        const wikipedia = createWikipediaSearch({ fetchImpl: adapterFetch });
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
    fetchPage = async (fetchUrl: string, signal?: AbortSignal) => {
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
          // SRC-23 (R-11 closure): no fetchImpl in production — safe-fetch
          // uses its pinned-IP transport, connecting to an address the
          // guard validated instead of re-resolving. Injected fetchImpl
          // (hermetic tests) delegates as before.
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
          ...(signal === undefined ? {} : { signal }),
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
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(signal === undefined ? {} : { signal }),
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

  let model: ModelProvider | undefined;
  if (config.modelProvider === "fixture") {
    model = new FakeModelProvider();
  } else if (config.modelProvider === "openai-compat" && config.modelOpenAI !== undefined) {
    const oc = config.modelOpenAI;
    // Key discipline: the secret NAME comes from config; the VALUE comes
    // from the process environment (production) or the injected test seam —
    // never a config file, never logged. useApiKey=false forces keyless
    // even when a secret is named (the operator kill-switch).
    let apiKey: string | undefined;
    if (oc.useApiKey && oc.apiKeySecret !== undefined) {
      const resolved = deps.modelApiKey ?? process.env[oc.apiKeySecret];
      if (resolved === undefined || resolved === "") {
        throw new Error(
          "DO_SIFT_MODEL_API_KEY_SECRET is set but its env var holds no value (set it or inject the test seam) — refusing to start half-configured instead of silently going keyless",
        );
      }
      apiKey = resolved;
    }
    const compat = createOpenAICompatModel({
      ...(apiKey === undefined ? {} : { apiKey }),
      // Host-direct transport (operator-chosen URL, not user input):
      // plain fetch, NOT the pinned safe-fetch pipeline — loopback model
      // servers (Ollama-local) sit behind the guards' private-IP refusal
      // by design. Hermetic tests inject deps.fetchImpl.
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    await compat.activate({
      events: { emit: () => {} },
      pluginName: "model-openai-compat",
      // #57: the operator-chosen baseURL host is the only host this direct
      // activation may contact (it bypasses the kernel grant path).
      network: {
        assertHostAllowed: (host: string) => {
          if (host !== new URL(oc.baseURL).hostname) {
            throw new Error(`model host "${host}" is not the configured baseURL host`);
          }
        },
      },
      config: {
        baseURL: oc.baseURL,
        modelId: oc.modelId,
        responseFormat: oc.responseFormat,
        schemaName: oc.schemaName,
        termsAcceptedAt: oc.termsAcceptedAt,
        sourcesEntry: oc.sourcesEntry,
      },
    } as unknown as Parameters<typeof compat.activate>[0]);
    model = compat;
  }

  const runtime = await createRuntime({
    client,
    search,
    fetchPage,
    ...(extract === undefined ? {} : { extract }),
    ...(model === undefined ? {} : { model }),
    ...(embedder === undefined ? {} : { embedder }),
  });

  // R-17: a real RS256/JWKS verifier when DO_SIFT_OIDC_* is configured. The
  // empty stub otherwise, so bearer tokens refuse and only the loopback dev
  // bypass works.
  const oidcVerifier: OidcVerifier =
    config.oidc === undefined
      ? new StaticOidcVerifier({})
      : new JwksOidcVerifier({
          issuer: config.oidc.issuer,
          audience: config.oidc.audience,
          jwksUrl: config.oidc.jwksUrl,
        });
  const auth = new AuthService(oidcVerifier, {
    allowlist: config.owners,
    devBypass: config.devBypass,
    ...(config.devOwner === undefined ? {} : { devOwner: config.devOwner }),
  });

  // #67: owner-authenticated Prometheus text at GET /metrics.
  const metrics = new MetricsRegistry();
  const server = createResearchServer({
    auth,
    metrics,
    runResearch: (ownerId, question, onSource, signal): Promise<ResearchRunOutcome> =>
      runtime.runResearch(ownerId, question, onSource, signal),
    // OPS-09: readiness is a dependency probe, while /healthz remains a
    // constant liveness signal. The probe is deliberately storage-only: it
    // does not call providers or expose owner/evidence data.
    readiness: async () => {
      await client.execute("SELECT 1");
      return true;
    },
    // Operational receipts contain only bounded request metadata. Never add
    // auth headers, request bodies, prompts, or provider/model payloads here.
    onEvent: (event) => {
      console.log(JSON.stringify({ component: "do-sift", ...event }));
    },
    ...(model === undefined
      ? {}
      : {
          answer: (ownerId: string, question: string, signal?: AbortSignal) =>
            runtime.answerResponse(ownerId, question, signal),
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
      // #62: stop accepting, drain briefly, then force-close idle SSE sockets
      // that would otherwise keep server.close() pending forever.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const forced = setTimeout(() => server.closeAllConnections(), 2_000);
      forced.unref();
      await closed;
      clearTimeout(forced);
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
    `  search: ${searchLabel} | model: ${modelLabel(config)} | embedder: ${config.embedder ?? "keyword-only"}`,
  );
  console.log(
    config.modelProvider === "openai-compat"
      ? "  budget: usage reconciles actuals per answer; keyed (billable-capable) hosts need daily caps + the router terms gate + INV-003 grant (see plans/sources.md)"
      : "  budget: no caps configured (fixture/live-search mode makes no billable calls)",
  );

  const shutdown = (): void => {
    // #62: hard exit so a stuck provider or socket can never hang SIGINT/SIGTERM
    const hardExit = setTimeout(() => process.exit(1), 10_000);
    hardExit.unref();
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
