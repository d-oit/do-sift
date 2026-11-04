/**
 * Live end-to-end evaluation runner (issue #123, plan 038 — EXT-04).
 *
 * Exercises the WHOLE answer path against chosen live adapters or an offline
 * fixture, in one process:
 *
 *   search provider → evidence stored → retrieval → one synthesis call →
 *   citation validation → stored answer
 *
 * Compared with `eval-live.ts` (which scores a model against a fixed corpus of
 * pre-written passages), this suite proves the *wiring*: that a real search and
 * fetch produce evidence the answer path can cite, and that the citation check
 * runs against what was actually stored.
 *
 * Opt-in and self-refusing, exactly like `eval-live.ts`: without an explicit
 * opt-in, an owner approval, and a dated terms/sources record it exits non-zero
 * with a named reason instead of pretending to have run. Fixture mode
 * (`--fixture`) is the hermetic form used by CI and by the wiring test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@libsql/client";
import {
  USER_AGENT,
  validateCitations,
  type ModelProvider,
  type SearchProvider,
} from "@do-sift/contracts";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import { createOpenAICompatModel } from "@do-sift/plugin-model-openai-compat";
import { createSiteAccessPolicy } from "@do-sift/plugin-policy-siteaccess";
import { createWikipediaSearch, wikipediaExtractUrl } from "@do-sift/plugin-search-wikipedia";
import { safeFetch, type DnsResolver } from "@do-sift/safe-fetch";
import { createRuntime } from "@do-sift/server";
import { applyMigrations, loadMigrations, Repositories } from "@do-sift/storage";

const ROOT = process.cwd();
const DEFAULT_QUESTION = "how does fts5 ranking work?";

/** The terms record the live adapters are activated with (checked dates). */
const WIKIPEDIA_TERMS = {
  termsAcceptedAt: "2026-09-14",
  sourcesEntry: "Wikipedia (MediaWiki action API, en.wikipedia.org) — checked 2026-09-14",
};

const realDns: DnsResolver = {
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
};

export interface MeanQualityThresholds {
  schemaVersion: number;
  description: string;
  thresholds: {
    minMeanQuality: number;
    minCitationResolution: number;
  };
}

/** One case's result, recorded so a failure names what actually happened. */
export interface E2ECaseResult {
  question: string;
  documentsStored: number;
  passagesStored: number;
  answerId: string;
  evidenceOnly: boolean;
  degraded: boolean;
  citationResolution: number;
  meanQuality: number;
  detail: string;
}

export interface E2ERunResult {
  schemaVersion: number;
  mode: "fixture" | "live";
  executedAtUtc: string;
  question: string;
  cases: E2ECaseResult[];
  meanQuality: number;
  citationResolution: number;
  passed: boolean;
  refusalReason?: string;
}

export interface E2EOptions {
  /** Hermetic fixture providers (default when nothing live was configured). */
  fixture: boolean;
  question: string;
  /** Live model, when not fixture. */
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  modelId?: string | undefined;
  termsAcceptedAt: string;
  sourcesEntry: string;
  ownerApproval: boolean;
  optIn: boolean;
}
/**
 * Score one case. The quality definition is deliberately blunt: an answer is
 * only worth 1 when its citations resolve against stored evidence AND it did
 * not degrade. Evidence-only output scores 0 — it is honest, but it is not a
 * synthesized answer, and the live gate exists to check the synthesis path.
 */
export function scoreCase(input: {
  evidenceOnly: boolean;
  degraded: boolean;
  citationsValid: boolean;
}): { citationResolution: number; meanQuality: number } {
  const citationResolution = input.citationsValid ? 1 : 0;
  const meanQuality = citationResolution === 1 && !input.degraded && !input.evidenceOnly ? 1 : 0;
  return { citationResolution, meanQuality };
}

/** Load and validate the committed threshold file (fail closed if malformed). */
export function loadThresholds(
  path = join(ROOT, "evals", "live-gate-thresholds.json"),
): MeanQualityThresholds {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MeanQualityThresholds>;
  const minMeanQuality = parsed.thresholds?.minMeanQuality;
  const minCitationResolution = parsed.thresholds?.minCitationResolution;
  if (typeof minMeanQuality !== "number" || typeof minCitationResolution !== "number") {
    throw new Error(
      `evals/live-gate-thresholds.json must define thresholds.minMeanQuality and thresholds.minCitationResolution (got ${JSON.stringify(parsed.thresholds)})`,
    );
  }
  return {
    schemaVersion: parsed.schemaVersion ?? 1,
    description: parsed.description ?? "",
    thresholds: { minMeanQuality, minCitationResolution },
  };
}

/**
 * Build the three injected providers for the chosen mode.
 *
 * Fixture mode is the hermetic wiring check. Live mode uses the same
 * composition the server does — the real Wikipedia adapter over the pinned
 * safe-fetch transport (site-access checked per hop) and the real
 * OpenAI-compatible model adapter — so a live pass is evidence about the
 * configured providers rather than about the fakes.
 */
async function buildProviders(
  fixture: boolean,
  env: Record<string, string | undefined>,
  cliArgs: ReturnType<typeof parseCLIArgs>,
  dns: DnsResolver,
  terms: { termsAcceptedAt: string; sourcesEntry: string },
): Promise<{
  search: SearchProvider;
  fetchPage: (url: string, signal?: AbortSignal) => Promise<{ text: string; contentType: string }>;
  model: ModelProvider;
}> {
  return fixture ? buildFixtureProviders() : buildLiveProviders(env, cliArgs, dns, terms);
}

/** The hermetic pair: labeled fakes, no network, no credentials. */
function buildFixtureProviders(): {
  search: SearchProvider;
  fetchPage: (url: string, signal?: AbortSignal) => Promise<{ text: string; contentType: string }>;
  model: ModelProvider;
} {
  return {
    search: new FakeSearchProvider({
      hits: [
        { url: "https://e2e.test/fts5", title: "FTS5 and bm25 ranking" },
        { url: "https://e2e.test/bm25", title: "Bm25 scoring" },
      ],
    }),
    fetchPage: async (url: string) => ({
      text: `<html><body><p>FTS5 provides full-text search to SQLite. Ranking uses the bm25 function where lower scores are better (${url}).</p></body></html>`,
      contentType: "text/html",
    }),
    model: new FakeModelProvider(),
  };
}

/** The real adapters, wired the way `apps/server` wires them. */
async function buildLiveProviders(
  env: Record<string, string | undefined>,
  cliArgs: ReturnType<typeof parseCLIArgs>,
  dns: DnsResolver,
  terms: { termsAcceptedAt: string; sourcesEntry: string },
): Promise<{
  search: SearchProvider;
  fetchPage: (url: string, signal?: AbortSignal) => Promise<{ text: string; contentType: string }>;
  model: ModelProvider;
}> {
  // Live search: the Wikipedia adapter (the only live adapter this runner
  // claims to exercise — the refusal above enforces that).
  const siteAccess = createSiteAccessPolicy();
  await siteAccess.activate({
    events: { emit: () => {} },
    config: { allowlist: env.DO_SIFT_FETCH_ALLOWLIST?.split(",").map((h) => h.trim()) ?? [] },
  } as unknown as Parameters<typeof siteAccess.activate>[0]);

  const wikipedia = createWikipediaSearch();
  await wikipedia.activate({
    events: { emit: () => {} },
    pluginName: "search-wikipedia",
    config: { ...WIKIPEDIA_TERMS },
    network: { assertHostAllowed: (host: string) => siteAccess.assertAllowed(host) },
  } as unknown as Parameters<typeof wikipedia.activate>[0]);

  const fetchPage = async (
    url: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; contentType: string }> => {
    // Wiki page URLs map to the plain-text extract endpoint (SRC-07); the
    // adapter's own hits always do, so anything else is a composition error
    // worth surfacing rather than silently fetching HTML.
    const extractUrl = wikipediaExtractUrl(url);
    if (extractUrl === undefined) {
      throw new Error(`live e2e got a non-wiki content url: ${url}`);
    }
    const result = await safeFetch(extractUrl, {
      maxBytes: 2_000_000,
      timeoutMs: 15_000,
      maxRedirects: 3,
      headers: { "user-agent": USER_AGENT },
      dns,
      ...(signal === undefined ? {} : { signal }),
      checkHost: (host) => siteAccess.assertAllowed(host),
    });
    const parsed = JSON.parse(result.text) as {
      query?: { pages?: Array<{ extract?: unknown }> };
    };
    const first = parsed.query?.pages?.[0];
    const extract = first?.extract;
    if (typeof extract !== "string" || extract === "") {
      throw new Error(`no plain-text extract returned for ${extractUrl}`);
    }
    return { text: extract, contentType: "text/plain" };
  };

  const baseURL = cliArgs["base-url"]!;
  const modelId = cliArgs["model-id"]!;
  // The key comes from the environment only — never an argv flag, which would
  // land in shell history and the process list. Keyless local servers omit it.
  const keySecretName = env.DO_SIFT_MODEL_API_KEY_SECRET;
  const apiKey =
    keySecretName !== undefined && keySecretName !== ""
      ? env[keySecretName]
      : env.DO_SIFT_MODEL_API_KEY;
  if (
    keySecretName !== undefined &&
    keySecretName !== "" &&
    (apiKey === undefined || apiKey === "")
  ) {
    // Deliberately does not name the variable: an error message reaches logs
    // and uploaded artifacts, and this repo's rule is that even the NAME of a
    // secret-bearing variable stays out of them (CodeQL clear-text-logging).
    throw new Error(
      "the configured model-key variable holds no value — refusing to run live e2e keyless (set it, or unset DO_SIFT_MODEL_API_KEY_SECRET for a keyless local server)",
    );
  }
  const compat = createOpenAICompatModel({
    ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
  });
  await compat.activate({
    events: { emit: () => {} },
    pluginName: "model-openai-compat",
    network: {
      assertHostAllowed: (host: string) => {
        if (host !== new URL(baseURL).hostname) {
          throw new Error(`model host "${host}" is not the configured base URL host`);
        }
      },
    },
    config: {
      baseURL,
      modelId,
      responseFormat: "strict",
      schemaName: "grounded_answer",
      termsAcceptedAt: terms.termsAcceptedAt,
      sourcesEntry: terms.sourcesEntry,
    },
  } as unknown as Parameters<typeof compat.activate>[0]);

  return { search: wikipedia, fetchPage, model: compat };
}

function parseCLIArgs() {
  const { values } = parseArgs({
    options: {
      "opt-in": { type: "boolean", default: false },
      "owner-approval": { type: "boolean", default: false },
      fixture: { type: "boolean", default: false },
      question: { type: "string" },
      provider: { type: "string" },
      "model-id": { type: "string" },
      "base-url": { type: "string" },
      "terms-accepted-at": { type: "string" },
      "sources-entry": { type: "string" },
      output: { type: "string" },
    },
    allowPositionals: true,
  });
  return values;
}

export async function runE2E(
  env: Record<string, string | undefined> = process.env,
  cliArgs: ReturnType<typeof parseCLIArgs> = parseCLIArgs(),
): Promise<E2ERunResult> {
  const optIn =
    cliArgs["opt-in"] ||
    env.DO_SIFT_EVAL_LIVE_OPT_IN === "1" ||
    env.DO_SIFT_EVAL_LIVE_OPT_IN === "true";
  const ownerApproval =
    cliArgs["owner-approval"] ||
    env.DO_SIFT_OWNER_APPROVAL === "1" ||
    env.DO_SIFT_OWNER_APPROVAL === "true";
  const termsAcceptedAt = cliArgs["terms-accepted-at"] || env.DO_SIFT_MODEL_TERMS_ACCEPTED_AT || "";
  const sourcesEntry = cliArgs["sources-entry"] || env.DO_SIFT_MODEL_SOURCES_ENTRY || "";
  // Fixture mode is the only hermetic form; live mode needs a provider + model.
  const fixture = cliArgs.fixture === true;
  const question = cliArgs.question ?? env.DO_SIFT_E2E_QUESTION ?? DEFAULT_QUESTION;
  const executedAtUtc = new Date().toISOString();

  const refusalReasons: string[] = [];
  if (!fixture) {
    if (!optIn) {
      refusalReasons.push(
        "Explicit opt-in is required for live e2e: set DO_SIFT_EVAL_LIVE_OPT_IN=1 or pass --opt-in (or use --fixture for the hermetic wiring check).",
      );
    }
    if (!ownerApproval) {
      refusalReasons.push(
        "Owner approval is required: set DO_SIFT_OWNER_APPROVAL=1 or pass --owner-approval.",
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u.test(termsAcceptedAt)) {
      refusalReasons.push(
        "Dated terms record is required: set DO_SIFT_MODEL_TERMS_ACCEPTED_AT (YYYY-MM-DD).",
      );
    }
    if (sourcesEntry.trim() === "") {
      refusalReasons.push(
        "Dated sources.md entry reference is required: set DO_SIFT_MODEL_SOURCES_ENTRY.",
      );
    }
    // Live means LIVE: a run that silently fell back to the fixture providers
    // would report a pass that proves nothing about the configured providers.
    if (cliArgs["model-id"] === undefined || cliArgs["model-id"].trim() === "") {
      refusalReasons.push(
        "Live e2e needs --model-id (the provider's model id) — refusing to fall back to the fixture model.",
      );
    }
    if (cliArgs["base-url"] === undefined || cliArgs["base-url"].trim() === "") {
      refusalReasons.push(
        "Live e2e needs --base-url (the OpenAI-shaped model endpoint) — refusing to fall back to the fixture model.",
      );
    }
    if ((cliArgs.provider ?? "wikipedia").trim() !== "wikipedia") {
      refusalReasons.push(
        `Live e2e currently supports --provider wikipedia (got "${cliArgs.provider}"); add an adapter to this runner before claiming another one is exercised.`,
      );
    }
  }

  const thresholds = loadThresholds();

  if (refusalReasons.length > 0) {
    return {
      schemaVersion: 1,
      mode: fixture ? "fixture" : "live",
      executedAtUtc,
      question,
      cases: [],
      meanQuality: 0,
      citationResolution: 0,
      passed: false,
      refusalReason: refusalReasons.join("; "),
    };
  }

  const client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  const repositories = new Repositories(client);
  await repositories.owners.ensure("e2e-owner", "E2E owner");

  const { search, fetchPage, model } = await buildProviders(fixture, env, cliArgs, realDns, {
    termsAcceptedAt,
    sourcesEntry,
  });

  const runtime = await createRuntime({
    client,
    search,
    fetchPage,
    model,
    tenantId: "default",
  });

  const summary = await runtime.runResearch("e2e-owner", question);
  const outcome = await runtime.answerResponse("e2e-owner", question);

  let citationsValid = true;
  try {
    validateCitations(
      {
        ownerId: "e2e-owner",
        question,
        evidenceOnly: outcome.evidenceOnly,
        blocks: outcome.blocks,
      },
      new Set(outcome.blocks.flatMap((block) => block.citations)),
    );
  } catch {
    citationsValid = false;
  }

  const scored = scoreCase({
    evidenceOnly: outcome.evidenceOnly,
    degraded: outcome.degraded,
    citationsValid,
  });

  const result: E2ERunResult = {
    schemaVersion: 1,
    mode: fixture ? "fixture" : "live",
    executedAtUtc,
    question,
    cases: [
      {
        question,
        documentsStored: summary.documentsStored,
        passagesStored: summary.passagesStored,
        answerId: outcome.answerId,
        evidenceOnly: outcome.evidenceOnly,
        degraded: outcome.degraded,
        citationResolution: scored.citationResolution,
        meanQuality: scored.meanQuality,
        detail:
          summary.documentsStored === 0
            ? "no evidence was stored: the search→store half of the pipeline produced nothing"
            : outcome.evidenceOnly
              ? "answer degraded to evidence-only output"
              : "grounded answer with resolved citations",
      },
    ],
    meanQuality: scored.meanQuality,
    citationResolution: scored.citationResolution,
    passed: false,
  };

  // The gate needs evidence to have flowed AND the answer to be grounded.
  if (summary.documentsStored === 0) {
    result.refusalReason = "no evidence stored by the research path";
  } else if (result.meanQuality < thresholds.thresholds.minMeanQuality) {
    result.refusalReason = `mean quality ${result.meanQuality} is below the ${thresholds.thresholds.minMeanQuality} floor`;
  } else if (result.citationResolution < thresholds.thresholds.minCitationResolution) {
    result.refusalReason = `citation resolution ${result.citationResolution} is below the ${thresholds.thresholds.minCitationResolution} floor`;
  }
  result.passed = result.refusalReason === undefined;
  return result;
}

/**
 * Redact secret values before anything reaches a log or artifact (EXT-04).
 * `eval-live.ts` does the same for completion text; here the inputs are the
 * resolved model key and any env var this process treats as secret-bearing.
 * The pattern list is a backstop for keys that arrived some other way.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/giu, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{20,})/giu, "[REDACTED]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]+/giu, "$1[REDACTED]");
}

/** Every env value this process could log through an error path. */
function secretValues(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const named = env.DO_SIFT_MODEL_API_KEY_SECRET;
  const candidates = [
    env.DO_SIFT_MODEL_API_KEY,
    named === undefined || named === "" ? undefined : env[named],
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== "") out.push(value);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("eval-e2e.ts")) {
  const args = parseCLIArgs();
  const secrets = secretValues(process.env);
  runE2E(process.env, args)
    .then((result) => {
      // A live run that actually RAN is evidence — pass or fail — and lands in
      // evals/quality. A refusal (nothing was executed) and a fixture wiring
      // check are not evidence and must never leave an artifact: a file named
      // for the day whose `cases` are empty would be read later as "the gate
      // ran and failed", which is a different claim.
      const ranLive = result.mode === "live" && result.cases.length > 0;
      const outputPath =
        args.output ??
        (ranLive
          ? join(ROOT, "evals", "quality", `e2e-${result.executedAtUtc.slice(0, 10)}.json`)
          : undefined);
      if (outputPath !== undefined) {
        writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
      }
      if (!result.passed) {
        const reason = result.refusalReason ?? "thresholds not met";
        console.error(`eval-e2e: FAIL — ${redactSecrets(reason, secrets)}`);
        process.exit(1);
      }
      console.log(
        `eval-e2e: PASS (${result.mode})${outputPath === undefined ? "" : ` — ${outputPath}`}`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      // Provider errors can carry response bodies or URLs; redact before
      // printing, and never print the env object itself.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`eval-e2e: ERROR — ${redactSecrets(message, secrets)}`);
      process.exit(1);
    });
}
