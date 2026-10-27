/** Labeled synthetic fixture pages/hits and the terms provenance for the dev composition (never a silent default). */
import { type DnsResolver } from "@do-sift/safe-fetch";
import { lookup as dnsLookup } from "node:dns/promises";
import { type AppConfig } from "./config.js";
export const realDns: DnsResolver = {
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
};
export const FIXTURE_PAGES: Record<string, { title: string; text: string }> = {
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
export const FIXTURE_SEARCH_HITS = [
  { url: "https://docs.test/fts5", title: "FTS5 notes", snippet: "fts5 bm25 ranking", rank: 0 },
  {
    url: "https://guide.test/hybrid",
    title: "Hybrid retrieval notes",
    snippet: "hybrid retrieval fusion",
    rank: 1,
  },
];
export const WIKIPEDIA_TERMS = {
  termsAcceptedAt: "2026-09-14",
  sourcesEntry: "Wikipedia (MediaWiki action API, en.wikipedia.org) — checked 2026-09-14",
};
export const MARGINALIA_TERMS = {
  termsAcceptedAt: "2026-09-15",
  sourcesEntry: "Marginalia Search (marginalia.nu) — checked 2026-09-15",
};
export function modelLabel(config: AppConfig): string {
  if (config.modelProvider === undefined) return "not configured (/api/answer → 501)";
  if (config.modelProvider === "fixture") return "fixture (synthetic, dev only)";
  const oc = config.modelOpenAI;
  if (oc === undefined) return "openai-compat (missing options — refusing would have fired first)";
  if (oc.apiKeySecret === undefined) {
    return `openai-compat (${oc.modelId} @ ${oc.baseURL}; keyless)`;
  }
  if (oc.useApiKey) {
    return `openai-compat (${oc.modelId} @ ${oc.baseURL}; key: configured)`;
  }
  return `openai-compat (${oc.modelId} @ ${oc.baseURL}; key disabled by config)`;
}
