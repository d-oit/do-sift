import { z } from "zod";
import { HttpUrl, PublishedAt } from "./common.js";

/**
 * One search result, exactly as the provider returned it. Providers are
 * wrapped so per-source data survives; results are never merged at this
 * layer (ADR 0003).
 */
export const SearchHit = z.object({
  url: HttpUrl,
  title: z.string().max(512).optional(),
  snippet: z.string().max(4096).optional(),
  provider: z.string().min(1).max(64),
  rank: z.number().int().nonnegative(),
  publishedAt: PublishedAt.optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchLimits = z.object({
  maxHits: z.number().int().min(1).max(25).default(6),
  timeoutMs: z.number().int().min(1).max(60_000).default(10_000),
});
export type SearchLimits = z.infer<typeof SearchLimits>;

export const SearchQuery = z.object({
  text: z.string().min(1).max(512),
  ownerId: z.string().min(1).max(128),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** Adapter interface every search plugin implements (see add-plugin skill). */
export interface SearchProvider {
  readonly name: string;
  search(query: SearchQuery, limits: SearchLimits, signal?: AbortSignal): Promise<SearchHit[]>;
}
