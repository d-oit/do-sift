/**
 * Merged search composition (SRC-16, plan 003): the recall-diversity
 * payoff of the second provider — BOTH adapters are queried per run and
 * their hits merged, so a page one provider's ranking structurally misses
 * (the R-16 class) still enters the evidence pipeline.
 *
 * The merge is pure and composition-layer (this is the host's job, not a
 * single plugin's): round-robin interleave in provider order (primary
 * first per round) preserves diversity in the face of a cap; dedup is by
 * exact URL string (SRC-01 canonicalization is still later work —
 * recorded); a provider failure degrades to the survivors rather than
 * failing the run, and the per-hit `provider` provenance keeps that
 * degradation VISIBLE in the receipts (a pool served entirely by one
 * provider shows it) — a typed error only when every provider fails.
 */
import type { SearchHit, SearchLimits, SearchQuery, SearchProvider } from "@do-sift/contracts";

export class MergedSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergedSearchError";
  }
}

/**
 * Interleave hit lists in provider order (list 0's rank-0 first), dedup by
 * exact URL, cap to `limit`. Original per-hit fields (provider, original
 * rank, source versions) are preserved — the merged order is the pool
 * order, provenance stays per-hit.
 */
export function mergeSearchHits(lists: SearchHit[][], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < maxLen; rank++) {
    for (const list of lists) {
      const hit = list[rank];
      if (hit === undefined || seen.has(hit.url)) continue;
      seen.add(hit.url);
      merged.push(hit);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/**
 * Compose one SearchProvider that fans out to every given provider and
 * merges their hits (see mergeSearchHits). Each provider is asked for the
 * caller's FULL limit so the interleaved cap retains diversity from every
 * source. Degrades to survivors on a per-provider failure.
 */
export function createMergedSearchProvider(
  providers: [SearchProvider, SearchProvider, ...Array<SearchProvider>],
): SearchProvider & { readonly providers: Array<SearchProvider> } {
  if (providers.length < 2) {
    throw new Error("createMergedSearchProvider needs at least two providers");
  }
  const names = providers.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new Error("createMergedSearchProvider needs distinct providers");
  }
  return {
    providers,
    get name() {
      return `merged(${names.join("+")})`;
    },
    async search(query: SearchQuery, limits: SearchLimits, signal?: AbortSignal) {
      const results = await Promise.all(
        providers.map(async (provider) => {
          try {
            return { ok: true as const, hits: await provider.search(query, limits, signal) };
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
