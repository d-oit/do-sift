/**
 * Merged search composition (SRC-16, plan 003): the recall-diversity
 * payoff of the second provider — BOTH adapters are queried per run and
 * their hits merged, so a page one provider's ranking structurally misses
 * (the R-16 class) still enters the evidence pipeline.
 *
 * The merge is pure and composition-layer (this is the host's job, not a
 * single plugin's): round-robin interleave in provider order (primary
 * first per round) preserves diversity in the face of a cap; dedup is on
 * the canonical URL key (SRC-19 — scheme/port/fragment/www./tracking
 * params converge, see canonicalizeUrl; unparseable URLs fall back to
 * exact-string dedup); a provider failure degrades to the survivors
 * rather than failing the run, and the per-hit `provider` provenance
 * keeps that degradation VISIBLE in the receipts (a pool served entirely
 * by one provider shows it) — a typed error only when every provider
 * fails.
 */
import type { SearchHit, SearchLimits, SearchQuery, SearchProvider } from "@do-sift/contracts";

export class MergedSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergedSearchError";
  }
}

/** Params that never change content — pure tracking. */
const TRACKING_PARAM = /^(utm_[^=]*|fbclid|gclid)$/iu;

/**
 * Canonical URL key for search-hit dedup (SRC-19). A conservative,
 * purposeful normalization — merge what is observably the same page for
 * retrieval, keep everything else distinct: WHATWG parse (undefined when
 * unparseable), scheme lowercased and http→https, default ports and the
 * fragment dropped, a leading `www.` stripped, tracking params removed,
 * remaining search params sorted, one trailing path slash dropped. The
 * stored `canonicalUrl` provenance keeps the provider's URL verbatim —
 * this key exists only for the merge. Recorded boundaries: mobile `m.`
 * hosts stay distinct (some sites serve genuinely different content
 * there), percent-encoding variants of reserved characters stay distinct
 * (WHATWG leaves `%27` and `'` apart), and multi-value param order
 * (`?a=2&a=1`) is not reordered beyond the stable name sort.
 */
export function canonicalizeUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.port === (parsed.protocol === "https:" ? "443" : "80")) parsed.port = "";
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  parsed.hostname = parsed.hostname.replace(/^www\./u, "");
  parsed.hash = "";
  parsed.pathname =
    parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/u, "") : parsed.pathname;
  const params = [...parsed.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  params.sort(([aName], [bName]) => (aName < bName ? -1 : aName > bName ? 1 : 0));
  parsed.search = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return parsed.href;
}

/**
 * Interleave hit lists in provider order (list 0's rank-0 first), dedup on
 * the canonical URL key, cap to `limit`. Original per-hit fields (provider,
 * original rank, source versions) are preserved verbatim — the merged
 * order is the pool order, provenance stays per-hit.
 */
export function mergeSearchHits(lists: SearchHit[][], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < maxLen; rank++) {
    for (const list of lists) {
      const hit = list[rank];
      if (hit === undefined) continue;
      const key = canonicalizeUrl(hit.url) ?? hit.url;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/**
 * Per-provider outcome of one merged search call (SRC-17): the health
 * receipt that makes survivor-degradation first-class in run summaries
 * instead of provenance-only.
 */
export interface ProviderHealthEntry {
  provider: string;
  ok: boolean;
  /** The failure's message when ok is false (truncated to 200 chars). */
  error?: string | undefined;
}

/**
 * Compose one SearchProvider that fans out to every given provider and
 * merges their hits (see mergeSearchHits). Each provider is asked for the
 * caller's FULL limit so the interleaved cap retains diversity from every
 * source. Degrades to survivors on a per-provider failure; every outcome
 * — success or failure — is recorded for `lastHealth()` (SRC-17), reset at
 * the start of each search call.
 */
export function createMergedSearchProvider(
  providers: [SearchProvider, SearchProvider, ...Array<SearchProvider>],
): SearchProvider & {
  readonly providers: Array<SearchProvider>;
  /** Per-provider outcomes of the most recent search call. */
  lastHealth(): ProviderHealthEntry[];
} {
  if (providers.length < 2) {
    throw new Error("createMergedSearchProvider needs at least two providers");
  }
  const names = providers.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new Error("createMergedSearchProvider needs distinct providers");
  }
  let health: ProviderHealthEntry[] = [];
  return {
    providers,
    lastHealth: () => health,
    get name() {
      return `merged(${names.join("+")})`;
    },
    async search(query: SearchQuery, limits: SearchLimits, signal?: AbortSignal) {
      health = [];
      const results = await Promise.all(
        providers.map(async (provider, index) => {
          try {
            const hits = await provider.search(query, limits, signal);
            health[index] = { provider: provider.name, ok: true };
            return { ok: true as const, hits };
          } catch (e) {
            // cancellation propagates; provider failure degrades to
            // survivors — the per-hit provider provenance shows which
            // sources contributed; typed error only if ALL fail
            if (
              (e instanceof Error && e.name === "AbortError") ||
              (typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "aborted")
            ) {
              throw e;
            }
            health[index] = {
              provider: provider.name,
              ok: false,
              error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
            };
            return { ok: false as const, hits: [] };
          }
        }),
      );
      if (results.every((r) => !r.ok)) {
        throw new MergedSearchError(
          `every search provider failed (${names.join(", ")}) for "${query.text.slice(0, 64)}"`,
        );
      }
      return mergeSearchHits(
        results.map((r) => r.hits),
        limits.maxHits,
      );
    },
  };
}
