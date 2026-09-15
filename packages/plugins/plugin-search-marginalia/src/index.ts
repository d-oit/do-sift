/**
 * Marginalia Search adapter (SRC-15, plan 003). The second live search
 * provider and the R-16 structural lever: a keyless independent index whose
 * recall covers the query classes the MediaWiki search API's ranking
 * structurally misses (live-verified 2026-09-15 — see plans/sources.md and
 * the SRC-15 spike evidence). The one host the manifest permits is
 * api.marginalia.nu; the verified legacy public path needs no key.
 *
 * Terms gate matches the wikipedia adapter: activation refuses without a
 * dated `termsAcceptedAt` and the `plans/sources.md` entry that clears this
 * source (checked 2026-09-15; result metadata CC BY-NC-SA 4.0 — storing
 * excerpts in the private owner-scoped evidence store preserves
 * attribution; commercial deployments must re-verify against a paid key).
 *
 * Error envelope (per sources.md): transient failures arrive as HTML
 * status pages (observed 504 Gateway Time-out under rapid probing), so
 * besides the polite single 429 retry (Retry-After honored exactly like the
 * wikipedia adapter), gateway-status 502/503/504 get ONE bounded retry at
 * a 1s delay when the cap allows — never hot, never more than one, typed
 * errors for everything else. A 200 with a non-JSON body is a typed error,
 * not a crash. Provider objects never cross the zod boundary: hits are
 * mapped and validated against the SearchHit contract here; descriptions
 * are already plain text (whitespace-normalized only). Marginalia carries
 * no publish dates, so `publishedAt` stays unset (honesty over
 * field-filling).
 */
import {
  SearchHit,
  SearchLimits,
  SearchQuery,
  type SearchHit as SearchHitT,
} from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface MarginaliaSearchConfig {
  termsAcceptedAt?: unknown;
  sourcesEntry?: unknown;
  retryCapMs?: unknown;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MarginaliaSearchDeps {
  /** Injectable for offline tests; defaults to the platform fetch. */
  fetchImpl?: FetchLike | undefined;
  /** Backoff ceiling for the single retry; tests shrink it to ~0. */
  retryCapMs?: number | undefined;
}

export class TermsGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermsGateError";
  }
}

export type SearchFailureKind = "http" | "rate-limited" | "timeout" | "aborted";

export class SearchProviderError extends Error {
  constructor(
    public readonly kind: SearchFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export interface MarginaliaSearchInstance extends PluginInstance {
  /** Contract identity (SearchProvider.name) — provenance records it. */
  readonly name: string;
  search(
    query: { text: string; ownerId: string },
    limits: { maxHits: number; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<SearchHitT[]>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u;
const HOST = "api.marginalia.nu";
const SEARCH_URL = `https://${HOST}/public/search/`;
/** Descriptive UA (same posture as the wikipedia adapter; sources.md). */
export const USER_AGENT = "do-sift/0.1 (research-with-receipts engine; contact via repo)";
/** Fixed wait before the single 502/503/504 gateway retry. */
const GATEWAY_RETRY_MS = 1000;

/**
 * Compute the wait before a single 429 retry from `Retry-After`
 * (delay-seconds or HTTP-date), identical discipline to the wikipedia
 * adapter: honored exactly when it fits `capMs`; null (no retry) when the
 * instruction exceeds the cap or the cap cannot cover the 5s etiquette
 * floor when no usable header is present.
 */
export function retry429DelayMs(
  retryAfter: string | null,
  capMs: number,
  nowMs: number = Date.now(),
): number | null {
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isInteger(seconds) && seconds >= 0) {
      const delayMs = seconds * 1000;
      return delayMs <= capMs ? delayMs : null;
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      const delayMs = Math.max(0, at - nowMs);
      return delayMs <= capMs ? delayMs : null;
    }
  }
  return capMs >= 5000 ? 5000 : null;
}

interface MarginaliaResultItem {
  url?: unknown;
  title?: unknown;
  description?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * HTML → plain text pre-pass for the marginalia content path (SRC-15):
 * marginalia hits are arbitrary web URLs, so the page arrives as HTML and
 * the readability extractor is a TEXT-block splitter — without this pre-pass
 * raw markup lands in stored passages (the QUAL run-001 F1 leak class).
 * Tags become block boundaries so the extractor's paragraph splitting has
 * structure to work on; script/style payloads are dropped. HONEST LIMIT
 * (same shape as the F1 finding): a naive tag stripper cannot remove
 * template-JSON-style text that a page embeds in visible content — the
 * QUAL gate observes real pages, not this fixture.
 */
export function pageHtmlToText(html: string): string {
  return (
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, "\n\n")
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&apos;/gu, "'")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&nbsp;/gu, " ")
      // numeric entities (decimal and hex) — observed live in the SRC-15
      // smoke as &#8212; surviving into answer blocks
      .replace(/&#(\d+);/gu, (_m, n: string) => safeCodePoint(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/gu, (_m, n: string) => safeCodePoint(Number.parseInt(n, 16)))
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim()
  );
}

function safeCodePoint(code: number): string {
  // unpaired surrogates and out-of-range codes stay literal (String.fromCodePoint throws on them)
  if (
    !Number.isInteger(code) ||
    code < 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return `&#${code};`;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return `&#${code};`;
  }
}

export function createMarginaliaSearch(deps: MarginaliaSearchDeps = {}): MarginaliaSearchInstance {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const retryCapMs = deps.retryCapMs ?? 5000;
  let activated = false;

  return {
    name: "marginalia",
    async activate(context) {
      const cfg = context.config as MarginaliaSearchConfig;

      const acceptedAt = cfg.termsAcceptedAt;
      const entry = cfg.sourcesEntry;
      if (typeof acceptedAt !== "string" || !ISO_DATE.test(acceptedAt)) {
        throw new TermsGateError(
          "activation refused: config.termsAcceptedAt must record the date the source terms were checked (see plans/sources.md)",
        );
      }
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new TermsGateError(
          "activation refused: config.sourcesEntry must name the plans/sources.md entry that clears this source",
        );
      }
      // Manifest-declared host, kernel-checked in kernel runs; host-direct
      // composition routes the same assertion through the site-access policy.
      context.network.assertHostAllowed(HOST);
      activated = true;
      context.events.emit("search-marginalia.activated", {
        sourcesEntry: entry,
        termsAcceptedAt: acceptedAt,
      });
    },

    async deactivate() {
      activated = false;
    },

    async search(query, limits, signal): Promise<SearchHitT[]> {
      if (!activated) throw new Error("search-marginalia is not activated");
      const q = SearchQuery.parse(query);
      SearchLimits.parse(limits);

      const url = SEARCH_URL + encodeURIComponent(q.text);
      const effectiveSignal =
        signal === undefined
          ? AbortSignal.timeout(limits.timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]);

      const doFetch = (): Promise<Response> =>
        fetchImpl(url, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: effectiveSignal,
        });
      const transportError = (e: unknown): SearchProviderError => {
        if (e instanceof Error && e.name === "TimeoutError") {
          return new SearchProviderError(
            "timeout",
            `marginalia search timed out after ${limits.timeoutMs}ms`,
          );
        }
        if (e instanceof Error && e.name === "AbortError") {
          return new SearchProviderError("aborted", "marginalia search aborted");
        }
        return new SearchProviderError(
          "http",
          `marginalia search transport failure: ${e instanceof Error ? e.message : String(e)}`,
        );
      };

      let res: Response;
      try {
        res = await doFetch();
      } catch (e) {
        throw transportError(e);
      }
      if (res.status === 429) {
        const delayMs = retry429DelayMs(res.headers.get("retry-after"), retryCapMs);
        if (delayMs === null) {
          throw new SearchProviderError(
            "rate-limited",
            "marginalia search is rate-limited (429; instructed Retry-After exceeds the bounded retry cap — no early retry)",
          );
        }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          res = await doFetch();
        } catch (e) {
          throw transportError(e);
        }
        if (res.status === 429) {
          throw new SearchProviderError(
            "rate-limited",
            "marginalia search is rate-limited (429 persisted after one Retry-After-honoring retry)",
          );
        }
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        // sources.md (2026-09-15): transient gateway status pages are the
        // observed failure mode — ONE bounded retry, never hot.
        if (retryCapMs >= GATEWAY_RETRY_MS) {
          await new Promise((resolve) => setTimeout(resolve, GATEWAY_RETRY_MS));
          try {
            res = await doFetch();
          } catch (e) {
            throw transportError(e);
          }
        }
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new SearchProviderError(
            "http",
            `marginalia search failed: HTTP ${res.status} (gateway status persisted after one bounded retry)`,
          );
        }
      }
      if (res.status !== 200) {
        throw new SearchProviderError("http", `marginalia search failed: HTTP ${res.status}`);
      }

      let body: { results?: MarginaliaResultItem[] };
      try {
        body = (await res.json()) as { results?: MarginaliaResultItem[] };
      } catch {
        throw new SearchProviderError(
          "http",
          "marginalia search returned a non-JSON body with HTTP 200 (recorded error envelope: HTML status pages)",
        );
      }
      const items = body.results ?? [];
      // Map at the contract boundary; an item that fails the contract (e.g.
      // a malformed URL) is skipped honestly, and the cap applies to VALID
      // hits. Survivors keep their provider-order rank (gaps are fine —
      // rank is provenance, not a dense index).
      const hits: SearchHitT[] = [];
      for (const [index, item] of items.entries()) {
        if (hits.length >= limits.maxHits) break;
        const parsed = SearchHit.safeParse({
          url: asString(item.url),
          title: normalizeWhitespace(asString(item.title)).slice(0, 512),
          snippet: normalizeWhitespace(asString(item.description)).slice(0, 4096),
          provider: "marginalia",
          rank: index,
        });
        if (parsed.success) hits.push(parsed.data);
      }
      return hits;
    },
  };
}
