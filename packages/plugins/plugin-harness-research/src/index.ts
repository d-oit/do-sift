/**
 * Research harness (SRC-01, plan 003). The zero-LLM pipeline:
 * search → site-policy check → fetch → extract → evidence storage.
 *
 * Architecture (ADR 0003/0004): this plugin orchestrates; it performs no
 * raw I/O. Search comes from an injected SearchProvider (terms gates live
 * in SRC-02 adapters), page fetching from an injected fetchPage the HOST
 * binds to safe-fetch (SSRF guards + size/time/MIME caps live there), and
 * storage through the owner-scoped Repositories. Every source is stored
 * with provenance BEFORE any merge or synthesis; nothing here calls a
 * model. Site policy: the contracts default-deny list gates every fetch;
 * the CORE-08 policy plugin extends this with robots/ToS registries.
 */
import { createHash } from "node:crypto";
import { SearchLimits, SearchQuery, isSiteDenied, type SearchProvider } from "@do-sift/contracts";
import type { PluginContext, PluginInstance } from "@do-sift/kernel";
import { backfillPassageEmbeddings } from "@do-sift/storage";
import type { BudgetService, Repositories, TextEmbedder } from "@do-sift/storage";

export interface ResearchHarnessConfig {
  maxHits?: unknown;
  maxFetches?: unknown;
}

export interface PageContent {
  text: string;
  contentType: string;
}

export interface ResearchHarnessDeps {
  search: SearchProvider;
  /** Host-provided fetch path (safeFetch-bound). Throws on refusal/failure. */
  fetchPage: (url: string) => Promise<PageContent>;
  repositories: Repositories;
  /** When present, the run reserves budget before and settles after. */
  budget?: BudgetService | undefined;
  /**
   * Extraction plugin output (SRC-03). When present it replaces the
   * built-in paragraph splitter; status flows into passage rows.
   */
  extract?: ((text: string) => Array<{ text: string; status: "ok" | "partial" }>) | undefined;
  /** Progress hook (SRC-05 SSE): fired after each source is fully stored. */
  onSource?:
    | ((source: { url: string; title?: string | undefined; passageCount: number }) => void)
    | undefined;
  /**
   * When present, newly stored passages are embedded for hybrid retrieval
   * (RET-03, ADR 0009): a backfill runs after storage and `embedded` counts
   * the newly indexed passages. Local ONNX inference — no external calls, no
   * ledger activity. An embedder failure never fails the run: it emits
   * "research.embeddings-failed" and leaves `embedded` undefined (the
   * passages stay retrievable via bm25).
   */
  embedder?: TextEmbedder | undefined;
}

export interface ResearchRunSummary {
  ownerId: string;
  question: string;
  hits: number;
  denied: number;
  fetches: number;
  fetchErrors: number;
  skippedBudget: number;
  documentsStored: number;
  passagesStored: number;
  budgetReservationId?: string | undefined;
  /** Newly embedded passages (RET-03); undefined with no embedder or on failure. */
  embedded?: number | undefined;
  /** The run's request row (ANS-07): documents link to it; failed runs fail it. */
  requestId?: string | undefined;
}

export interface ResearchHarnessInstance extends PluginInstance {
  run(task: { ownerId: string; question: string }): Promise<ResearchRunSummary>;
}

/** Bound work per document; the readability extractor (SRC-03) replaces this. */
const MAX_PASSAGES_PER_DOC = 20;
const MAX_EXCERPT = 8192;
const MIN_EXCERPT = 20;

/** Split raw text into paragraph-ish excerpts (deterministic, no deps). */
export function extractPassages(text: string): string[] {
  return text
    .split(/\r?\n\r?\n+/u)
    .map((p) => p.replace(/\s+/gu, " ").trim())
    .filter((p) => p.length >= MIN_EXCERPT)
    .slice(0, MAX_PASSAGES_PER_DOC)
    .map((p) => p.slice(0, MAX_EXCERPT));
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function createResearchHarness(
  ctx: PluginContext,
  deps: ResearchHarnessDeps,
): ResearchHarnessInstance {
  let maxHits = 6;
  let maxFetches = 3;
  let activated = false;

  return {
    activate(context: PluginContext) {
      const cfg = context.config as ResearchHarnessConfig;
      maxHits = positiveInt(cfg.maxHits, 6);
      maxFetches = positiveInt(cfg.maxFetches, 3);
      activated = true;
      context.events.emit("research-harness.activated", { maxHits, maxFetches });
    },

    async deactivate() {
      activated = false;
    },

    async run(task: { ownerId: string; question: string }): Promise<ResearchRunSummary> {
      if (!activated) throw new Error("research harness is not activated");
      const query = SearchQuery.parse({ text: task.question, ownerId: task.ownerId });
      const limits = SearchLimits.parse({ maxHits });

      const summary: ResearchRunSummary = {
        ownerId: task.ownerId,
        question: task.question,
        hits: 0,
        denied: 0,
        fetches: 0,
        fetchErrors: 0,
        skippedBudget: 0,
        documentsStored: 0,
        passagesStored: 0,
        budgetReservationId: undefined,
      };

      // budgets are reserved atomically BEFORE any external call (AGENTS.md);
      // search mode makes zero model calls, so token ceilings are nominal.
      // ANS-07: the run gets its own request row; stored documents link to
      // it so the answer path can report an honest evidence basis.
      const requestId = await deps.repositories.requests.create(
        task.ownerId,
        "search",
        task.question,
      );
      summary.requestId = requestId;
      try {
        if (deps.budget !== undefined) {
          const { id } = await deps.budget.reserve({
            ownerId: task.ownerId,
            requestId,
            request: {
              maxInputTokens: 1,
              maxOutputTokens: 1,
              maxSearchCalls: 1,
              maxFetches: maxFetches,
              deadlineMs: 30_000,
            },
            estimatedInputTokens: 0,
            nowMs: Date.now(),
          });
          summary.budgetReservationId = id;
        }

        try {
          const hits = await deps.search.search(query, limits);
          summary.hits = hits.length;

          for (const hit of hits) {
            if (summary.fetches >= maxFetches) {
              summary.skippedBudget++;
              continue;
            }
            let host: string;
            try {
              host = hostOf(hit.url);
            } catch {
              summary.fetchErrors++;
              continue;
            }
            if (isSiteDenied(host)) {
              summary.denied++;
              continue; // never fetched
            }
            try {
              const page = await deps.fetchPage(hit.url);
              const docId = await deps.repositories.documents.insert({
                ownerId: task.ownerId,
                canonicalUrl: hit.url, // canonicalization is later work (SRC-03+)
                originalUrl: hit.url,
                contentHash: createHash("sha256").update(page.text, "utf8").digest("hex"),
                fetchedAt: new Date().toISOString(),
                publishedAt: hit.publishedAt?.at,
                publishedOrigin: hit.publishedAt?.origin,
                title: hit.title,
                rawMime: page.contentType,
                rawText: page.text,
                requestId,
              });
              summary.fetches++;
              summary.documentsStored++;
              const extracted = deps.extract
                ? deps.extract(page.text)
                : extractPassages(page.text).map((text) => ({ text, status: "ok" as const }));
              for (const passage of extracted) {
                await deps.repositories.passages.insert({
                  ownerId: task.ownerId,
                  documentId: docId,
                  excerpt: passage.text,
                  extractionStatus: passage.status,
                });
                summary.passagesStored++;
              }
              deps.onSource?.({
                url: hit.url,
                title: hit.title ?? undefined,
                passageCount: extracted.length,
              });
            } catch {
              summary.fetchErrors++;
            }
          }
        } finally {
          if (deps.budget !== undefined && summary.budgetReservationId !== undefined) {
            await deps.budget.settle({
              ownerId: task.ownerId,
              reservationId: summary.budgetReservationId,
              actual: { inputTokens: 0, outputTokens: 0, searchCalls: 1, fetches: summary.fetches },
              nowMs: Date.now(),
            });
          }
        }

        // Index what we stored for hybrid retrieval (RET-03). Local ONNX
        // inference: no external calls, no ledger activity. Failure degrades
        // honestly — the passages remain bm25-retrievable.
        if (deps.embedder !== undefined) {
          try {
            summary.embedded = await backfillPassageEmbeddings(
              deps.repositories.db,
              task.ownerId,
              deps.embedder,
            );
          } catch (error) {
            ctx.events.emit("research.embeddings-failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        ctx.events.emit("research.completed", {
          ownerId: summary.ownerId,
          requestId: summary.requestId,
          hits: summary.hits,
          documentsStored: summary.documentsStored,
          passagesStored: summary.passagesStored,
        });
        await deps.repositories.requests.complete(task.ownerId, requestId);
        return summary;
      } catch (error) {
        // ANS-07: a failed run fails its request row — no phantom
        // "completed" run the answer basis could ever trust.
        await deps.repositories.requests.fail(task.ownerId, requestId).catch(() => {});
        throw error;
      }
    },
  };
}
