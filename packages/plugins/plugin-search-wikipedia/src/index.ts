/**
 * Wikipedia search adapter (SRC-06, plan 003). The first live search
 * provider: free, keyless MediaWiki action API on en.wikipedia.org — the
 * one host the manifest permits. Terms gate matches the fixture plugin:
 * activation refuses without a dated `termsAcceptedAt` and the
 * `plans/sources.md` entry that clears this source (checked 2026-09-14).
 *
 * Politeness (per plans/sources.md, tightened by the 2026-09-14 policy
 * research in SRC-07): descriptive User-Agent, one bounded 429 retry that
 * NEVER fires before the instructed `Retry-After` — over-cap instructions
 * and caps too small for the 5s etiquette floor mean no retry at all —
 * typed errors for every failure, never a hang, never a fallback.
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
/**
 * Descriptive UA per the Wikimedia User-Agent policy (checked
 * 2026-09-14): `<client>/<version> (<contact>)`. The contact slot names
 * the repo — no public URL or email is recorded for this project yet
 * (plans/risks.md); generic defaults are 403-eligible and land in the
 * 10 req/min unidentified rate class.
 */
export const USER_AGENT = "do-sift/0.1 (research-with-receipts engine; contact via repo)";

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

/**
 * Map a wiki page URL to its MediaWiki plain-text extract API URL
 * (SRC-07): `prop=extracts&explaintext=1` returns article prose instead
 * of HTML, so no stripping pipeline is needed and template metadata
 * cannot leak into stored passages. undefined for anything that is not
 * an en.wikipedia.org wiki page.
 */
export function wikipediaExtractUrl(wikiUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(wikiUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== HOST) return undefined;
  const match = /^\/wiki\/(.+)$/u.exec(parsed.pathname);
  if (match === null || match[1] === undefined || match[1] === "") return undefined;
  let title: string;
  try {
    title = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return `https://${HOST}/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(title)}`;
}

/**
 * Compute the wait before a single 429 retry from `Retry-After`
 * (RFC 9110 §10.2.3: delay-seconds or HTTP-date). The 2026 Wikimedia
 * rate-limit policy says respect the header — so the delay is honored
 * exactly when it fits `capMs`, and an instruction that exceeds the cap
 * (or a cap too small for the 5s etiquette floor when no header is
 * usable) returns null: no retry beats an early or hot one.
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
        `&formatversion=2&srsearch=${encodeURIComponent(q.text)}` +
        `&srlimit=${limits.maxHits}`;
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
        const delayMs = retry429DelayMs(res.headers.get("retry-after"), retryCapMs);
        if (delayMs === null) {
          throw new SearchProviderError(
            "rate-limited",
            "wikipedia search is rate-limited (429; instructed Retry-After exceeds the bounded retry cap — no early retry)",
          );
        }
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
