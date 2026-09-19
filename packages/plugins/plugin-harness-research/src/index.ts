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
import {
  backfillPassageEmbeddings,
  backfillPassageNoiseClasses,
  cosineSimilarity,
  type PassageInput,
  type PassageNoiseClass,
} from "@do-sift/storage";
import type { BudgetService, DocumentInput, Repositories, TextEmbedder } from "@do-sift/storage";

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
    | ((source: {
        url: string;
        title?: string | undefined;
        passageCount: number;
        /** SRC-14: the raw store-time similarity receipt (undefined without
         * an embedder). The RUNTIME decides prominence — the floor is the
         * composition's option, not the harness's. */
        relevanceScore?: number | undefined;
      }) => void)
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
  /** Legacy passages classified by the SRC-13 backfill this run; undefined on failure. */
  noiseBackfilled?: number | undefined;
  /**
   * SRC-17: per-provider sub-search outcomes for this run's search call
   * (merged compositions only; undefined for single-provider runs). The
   * health receipt makes survivor-degradation first-class in run
   * summaries instead of provenance-only.
   */
  providerHealth?: Array<{ provider: string; ok: boolean; error?: string | undefined }> | undefined;
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

/**
 * Noise-class classification (SRC-12, store-with-flag). A PURE text
 * heuristic applied per extracted chunk at store time; the class is a
 * receipt, exclusion happens at read time (answer pool only). Shapes are
 * anchored to the verbatim captured evidence in the QUAL run artifacts
 * (see plans/003-004-src-ans.md SRC-12/SRC-18). Precision-over-recall by
 * design: a false flag suppresses real evidence from the answer pool, a
 * miss only leaves one noisy block. Bare table-caption stubs and
 * mid-formula fragments are deliberately NOT classified — by text alone
 * a caption is indistinguishable from a legitimate short fact-bearing
 * sentence (segmentation work, disclosed not fixed). SRC-18 added the
 * `fragment` class for the HTML-conversion chunk shapes that ARE
 * text-distinguishable and reached the answer pool twice (run-008/009
 * case-07): short bullet items, pipe-separated page titles, short
 * unpunctuated truncations ending on a stopword/"part", and standalone
 * pure questions up to 100 chars.
 */
export function classifyNoise(text: string): PassageNoiseClass | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // nav-list: a run of concatenated list-entry titles (the run-006
  // case-06 shape — "List of … List of … List of …"), not prose.
  const listLeads = trimmed.match(/\bList of\b/gu)?.length ?? 0;
  if (listLeads >= 3) return "nav-list";
  // reference: bibliography/citation markers (run-005 case-05, run-006
  // case-06 shapes — "Retrieved <date>", doi:, ISBN).
  if (
    /\bRetrieved\s+[A-Z][a-z]+\s+\d{1,2}\b/u.test(trimmed) ||
    /\bRetrieved\s+\d{1,2}\s+[A-Z][a-z]+\b/u.test(trimmed) ||
    /\bdoi:\s?\S/u.test(trimmed) ||
    /\bISBN\b/u.test(trimmed)
  ) {
    return "reference";
  }
  // stub: a chunk ENDING in a colon is a list lead-in whose list content
  // was split away (the run-005 case-04 shape) — not self-contained prose.
  if (trimmed.endsWith(":")) return "stub";
  // fragment (SRC-18): segmentation fragments from the raw-HTML
  // conversion path. Each rule is a length-capped shape a legitimate
  // chunk essentially never takes: a leading bullet mark (converted list
  // item), a two-part pipe split (the page <title>), an unpunctuated
  // truncation ending on a stopword/"part" (a cut-off link title), or a
  // standalone single question (hero/tagline chrome). Terminal
  // punctuation or interior sentences keep real prose unflagged; longer
  // bullet/table/question content stays (disclosed boundary).
  if (trimmed.startsWith("- ") && trimmed.length <= 200) return "fragment";
  if (trimmed.length <= 120 && /^[^|]+\|[^|]+$/u.test(trimmed)) return "fragment";
  if (
    trimmed.length <= 120 &&
    !/[.!?…]["'”’)\]]?$/u.test(trimmed) &&
    /\b(of|and|the|in|for|with|on|to|by|from|at|part)$/iu.test(trimmed)
  ) {
    return "fragment";
  }
  if (trimmed.length <= 100 && trimmed.endsWith("?") && !/[.!?]/u.test(trimmed.slice(0, -1))) {
    return "fragment";
  }
  return undefined;
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
              // SRC-11 (store-with-flag): per-source evidence relevance —
              // cosine(question, FULL plain-text extract) computed ONCE per
              // source, BEFORE passage chunking. The extract is passed WHOLE
              // and UNCHUNKED (accepted-lead semantics): fastembed silently
              // truncates to ~512 tokens, so this is LEAD-WINDOW similarity
              // by design (see plans/003-004-src-ans.md SRC-11). Advisory
              // only: an embedding failure never blocks the store — the
              // document stores with an undefined score (mirror of the
              // RET-03 embed-on-store failure pattern: emit, continue).
              let relevanceScore: number | undefined;
              if (deps.embedder !== undefined) {
                try {
                  const questionVector = await deps.embedder.embedQuery(task.question);
                  const extractVector = (await deps.embedder.embedPassages([page.text]))[0];
                  if (questionVector !== undefined && extractVector !== undefined) {
                    relevanceScore = cosineSimilarity(questionVector, extractVector);
                  }
                } catch (error) {
                  ctx.events.emit("research.relevance-failed", {
                    message: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              // exactOptionalPropertyTypes: build the literal first, assign
              // conditionally (recurring class RET-04/RET-06/RET-07).
              const docInit: DocumentInput = {
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
              };
              if (relevanceScore !== undefined) docInit.relevanceScore = relevanceScore;
              const docId = await deps.repositories.documents.insert(docInit);
              summary.fetches++;
              summary.documentsStored++;
              const extracted = deps.extract
                ? deps.extract(page.text)
                : extractPassages(page.text).map((text) => ({ text, status: "ok" as const }));
              for (const passage of extracted) {
                // SRC-12 (store-with-flag): per-chunk noise class computed
                // at store time — pure text heuristic, no failure path,
                // receipts kept; exclusion is read-time (answer pool).
                const noiseClass = classifyNoise(passage.text);
                const passageInit: PassageInput = {
                  ownerId: task.ownerId,
                  documentId: docId,
                  excerpt: passage.text,
                  extractionStatus: passage.status,
                };
                if (noiseClass !== undefined) passageInit.noiseClass = noiseClass;
                await deps.repositories.passages.insert(passageInit);
                summary.passagesStored++;
              }
              deps.onSource?.({
                url: hit.url,
                title: hit.title ?? undefined,
                passageCount: extracted.length,
                ...(relevanceScore === undefined ? {} : { relevanceScore }),
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

        // Legacy noise-class backfill (SRC-13): converge a pre-SRC-12
        // store at run time, owner-scoped and idempotent (the pure
        // classifier is injected). Advisory like the embeddings backfill:
        // emit and continue — never a run failure.
        try {
          summary.noiseBackfilled = await backfillPassageNoiseClasses(
            deps.repositories.db,
            task.ownerId,
            classifyNoise,
          );
        } catch (error) {
          ctx.events.emit("research.noise-backfill-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
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
