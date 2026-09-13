/**
 * Fixture search provider (SRC-02, plan 003). The first search adapter,
 * deliberately offline: retrieval is deterministic keyword scoring over a
 * config-supplied fixture corpus, validated against the SearchHit contract.
 *
 * Terms gate (AGENTS.md / plans/sources.md): activation REFUSES unless the
 * config records `termsAcceptedAt` (ISO date the terms were checked) and
 * `sourcesEntry` (the sources.md section that clears this source). Live
 * providers inherit this gate; a live adapter additionally requires its own
 * dated sources.md entry before it may ship at all.
 *
 * Zero capabilities: no network, no secrets. The manifest is the proof.
 */
import {
  SearchHit,
  SearchLimits,
  SearchQuery,
  type SearchHit as SearchHitT,
} from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface FixtureSearchConfig {
  termsAcceptedAt?: unknown;
  sourcesEntry?: unknown;
  fixtures?: unknown;
}

export interface FixtureInput {
  url: string;
  title?: string;
  snippet?: string;
  provider?: string;
}

export class TermsGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermsGateError";
  }
}

export interface FixtureSearchInstance extends PluginInstance {
  search(
    query: { text: string; ownerId: string },
    limits: { maxHits: number; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<SearchHitT[]>;
  readonly queries: Array<{ text: string; ownerId: string }>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u;

/** Deterministic query tokens: lowercase words, length ≥ 2. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/gu) ?? []).filter((t) => t.length >= 2);
}

function scoreFixture(hit: SearchHitT, tokens: string[]): number {
  const haystack = `${hit.title ?? ""} ${hit.snippet ?? ""}`.toLowerCase();
  return tokens.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0);
}

export function createFixtureSearch(): FixtureSearchInstance {
  let corpus: SearchHitT[] = [];
  let activated = false;
  const queries: Array<{ text: string; ownerId: string }> = [];

  return {
    async activate(context) {
      const cfg = context.config as FixtureSearchConfig;

      // ---- terms gate: no recorded sources.md entry, no activation ----
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

      const fixtures = Array.isArray(cfg.fixtures) ? cfg.fixtures : [];
      corpus = fixtures.map((f) =>
        SearchHit.parse({
          url: (f as FixtureInput).url,
          title: (f as FixtureInput).title ?? `Fixture ${(f as FixtureInput).url}`,
          snippet: (f as FixtureInput).snippet ?? "",
          provider: (f as FixtureInput).provider ?? context.pluginName,
          rank: 0,
        }),
      );
      activated = true;
      context.events.emit("search-fixture.activated", {
        fixtures: corpus.length,
        sourcesEntry: entry,
        termsAcceptedAt: acceptedAt,
      });
    },

    async deactivate() {
      activated = false;
    },

    queries,

    async search(query, limits, signal) {
      if (!activated) throw new Error("search-fixture is not activated");
      if (signal?.aborted) throw new Error("aborted before the fixture search ran");
      const q = SearchQuery.parse(query);
      SearchLimits.parse(limits);
      queries.push({ text: q.text, ownerId: q.ownerId });

      const tokens = tokenize(q.text);
      if (tokens.length === 0) return [];
      return corpus
        .map((hit, index) => ({ hit, index, score: scoreFixture(hit, tokens) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limits.maxHits)
        .map((e, rank) => ({ ...e.hit, rank }));
    },
  };
}
