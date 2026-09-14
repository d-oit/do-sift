/**
 * Wikipedia search adapter (SRC-06, plan 003). The first live search
 * provider: free, keyless MediaWiki action API on en.wikipedia.org — the
 * one host the manifest permits. Terms gate matches the fixture plugin:
 * activation refuses without a dated `termsAcceptedAt` and the
 * `plans/sources.md` entry that clears this source (checked 2026-09-14).
 *
 * Politeness (per plans/sources.md): descriptive User-Agent, one bounded
 * retry on 429 honoring `Retry-After` (capped by config.retryCapMs), typed
 * errors for every failure — never a hang, never an automatic fallback.
 * Provider objects never cross the zod boundary: hits are mapped and
 * validated against the SearchHit contract here; snippet HTML is stripped
 * at this boundary. MediaWiki timestamps are last-edit, not publish, so
 * `publishedAt` stays unset (honesty over field-filling).
 */
import {
  SearchHit,
  SearchLimits,
  SearchQuery,
  type SearchHit as SearchHitT,
} from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface WikipediaSearchConfig {
  termsAcceptedAt?: unknown;
  sourcesEntry?: unknown;
  retryCapMs?: unknown;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WikipediaSearchDeps {
  /** Injectable for offline tests; defaults to the platform fetch. */
  fetchImpl?: FetchLike | undefined;
  /** Backoff ceiling for the single 429 retry; tests shrink it to ~0. */
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

export interface WikipediaSearchInstance extends PluginInstance {
  /** Contract identity (SearchProvider.name) — provenance records it. */
  readonly name: string;
  search(
    query: { text: string; ownerId: string },
    limits: { maxHits: number; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<SearchHitT[]>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u;
const HOST = "en.wikipedia.org";
const USER_AGENT = "do-sift/0.1 (research-with-receipts engine; contact via repo)";

/** Provider snippets carry HTML markup; strip it at the contract boundary. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function wikiUrl(title: string): string {
  return `https://${HOST}/wiki/${encodeURIComponent(title.replaceAll(" ", "_").slice(0, 512))}`;
}

interface MwSearchItem {
  title?: unknown;
  snippet?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createWikipediaSearch(deps: WikipediaSearchDeps = {}): WikipediaSearchInstance {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const retryCapMs = deps.retryCapMs ?? 5000;
  let activated = false;

  return {
    name: "wikipedia",
    async activate(context) {
      const cfg = context.config as WikipediaSearchConfig;

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
      context.events.emit("search-wikipedia.activated", {
        sourcesEntry: entry,
        termsAcceptedAt: acceptedAt,
      });
    },

    async deactivate() {
      activated = false;
    },

    async search(query, limits, signal): Promise<SearchHitT[]> {
      if (!activated) throw new Error("search-wikipedia is not activated");
      const q = SearchQuery.parse(query);
      SearchLimits.parse(limits);

      const url =
        `https://${HOST}/w/api.php?action=query&list=search&format=json` +
        `&srsearch=${encodeURIComponent(q.text)}&srlimit=${limits.maxHits}`;
      const effectiveSignal =
        signal === undefined
          ? AbortSignal.timeout(limits.timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: effectiveSignal,
        });
      } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") {
          throw new SearchProviderError(
            "timeout",
            `wikipedia search timed out after ${limits.timeoutMs}ms`,
          );
        }
        if (e instanceof Error && e.name === "AbortError") {
          throw new SearchProviderError("aborted", "wikipedia search aborted");
        }
        throw new SearchProviderError(
          "http",
          `wikipedia search transport failure: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (res.status === 429) {
        // The path that fetched without the retry wrapper — same bounded rule.
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        const delayMs = Math.max(
          0,
          Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, retryCapMs),
        );
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        res = await fetchImpl(url, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: effectiveSignal,
        });
        if (res.status === 429) {
          throw new SearchProviderError(
            "rate-limited",
            "wikipedia search is rate-limited (429 persisted after one Retry-After-honoring retry)",
          );
        }
      }
      if (res.status !== 200) {
        throw new SearchProviderError("http", `wikipedia search failed: HTTP ${res.status}`);
      }

      const body = (await res.json()) as { query?: { search?: MwSearchItem[] } };
      const items = body.query?.search ?? [];
      return items.slice(0, limits.maxHits).map((item, rank) =>
        SearchHit.parse({
          url: wikiUrl(asString(item.title)),
          title: asString(item.title).slice(0, 512),
          snippet: stripHtml(asString(item.snippet)).slice(0, 4096),
          provider: "wikipedia",
          rank,
        }),
      );
    },
  };
}
