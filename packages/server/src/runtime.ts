/**
 * Host runtime composition (RET-04, plan 011). The seam that turns the
 * pieces — repositories, budget ledger, research harness (embed-on-store),
 * answer service (hybrid retrieval) — into one wired runtime:
 *
 *   runResearch (zero-LLM pipeline, embeds what it stores)
 *   → answer (exactly one bounded synthesis call over hybrid retrieval)
 *
 * Providing an `embedder` flips BOTH sides to the RET-02/03 hybrid behavior
 * (measured + promoted in plans/011); omitting it keeps byte-identical
 * keyword-only behavior. This file is host infrastructure like server.ts:
 * it composes, it never performs raw I/O beyond what the injected deps do.
 * A single runtime serves one owner-scoped process; concurrent research
 * runs share the onSource forwarding slot by design (dev scale).
 */
import type { Client } from "@libsql/client";
import type { ModelProvider, SearchProvider } from "@do-sift/contracts";
import type { PluginContext } from "@do-sift/kernel";
import {
  createResearchHarness,
  type PageContent,
  type ResearchRunSummary,
} from "@do-sift/plugin-harness-research";
import { BudgetService, Repositories, type DailyCaps, type TextEmbedder } from "@do-sift/storage";
import { createAnswerService, type AnswerOutcome } from "./answer.js";
import type { AnswerHttpResponse } from "./server.js";

export interface RuntimeOptions {
  client: Client;
  /** Search adapter (terms gates live in the adapter, not here). */
  search: SearchProvider;
  /** Host-bound safe fetch path (SSRF guards live there). */
  fetchPage: (url: string) => Promise<PageContent>;
  /** Extraction plugin output; default = the harness's built-in splitter. */
  extract?: ((text: string) => Array<{ text: string; status: "ok" | "partial" }>) | undefined;
  /**
   * Answer-path model: exactly one bounded call per question (ADR 0006).
   * Optional since OPS-05: search mode is zero-LLM by product invariant, so
   * a research-only runtime omits it and answer/answerResponse refuse.
   */
  model?: ModelProvider | undefined;
  /** Daily caps for the usage ledger; omit to run without a budget. */
  budgetCaps?: DailyCaps | undefined;
  /**
   * Hybrid retrieval + embed-on-store (RET-02/03/04). Omit → keyword-only
   * bm25 on both sides, byte-identical to the pre-RET behavior.
   */
  embedder?: TextEmbedder | undefined;
  /** Harness limits (defaults: 6 hits, 3 fetches). */
  maxHits?: number;
  maxFetches?: number;
  /** Answer retrieval cap (default 6). */
  maxPassages?: number;
  /**
   * SRC-11 answer-time exclusion floor (default 0.70, designed in
   * plans/003-004-src-ans.md). Storage is unconditional; this tunes the
   * pool at read time only. Surface kept minimal: options-level, no env
   * wiring (the packaged entrypoint runs the designed default).
   */
  relevanceFloor?: number;
}

export interface Runtime {
  repositories: Repositories;
  budgets: BudgetService | undefined;
  runResearch(
    ownerId: string,
    question: string,
    onSource?: (source: { url: string; title?: string | undefined; passageCount: number }) => void,
  ): Promise<ResearchRunSummary>;
  answer(task: { ownerId: string; question: string }, signal?: AbortSignal): Promise<AnswerOutcome>;
  /**
   * Answer plus the stored blocks, composed for the HTTP surface (ANS-05):
   * outcome flags joined with the persisted answer (citations resolve to
   * stored evidence). Throws if the answer service failed or the stored row
   * is missing.
   */
  answerResponse(ownerId: string, question: string): Promise<AnswerHttpResponse>;
}

const NO_MODEL_MESSAGE =
  "no model configured: the answer surface needs a configured model (search mode runs with zero LLM calls)";

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const repositories = new Repositories(options.client);
  const budgets =
    options.budgetCaps === undefined
      ? undefined
      : new BudgetService(options.client, options.budgetCaps);

  let currentOnSource:
    | ((source: { url: string; title?: string | undefined; passageCount: number }) => void)
    | undefined;
  const harness = createResearchHarness(
    { events: { emit: () => {} } } as unknown as PluginContext,
    {
      search: options.search,
      fetchPage: options.fetchPage,
      repositories,
      budget: budgets,
      extract: options.extract,
      onSource: (source) => currentOnSource?.(source),
      ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    },
  );
  await harness.activate({
    events: { emit: () => {} },
    config: { maxHits: options.maxHits, maxFetches: options.maxFetches },
  } as unknown as PluginContext);

  const answers =
    options.model === undefined
      ? undefined
      : createAnswerService(
          {
            client: options.client,
            repositories,
            model: options.model,
            budget: budgets,
            ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
          },
          {
            ...(options.maxPassages === undefined ? {} : { maxPassages: options.maxPassages }),
            ...(options.relevanceFloor === undefined
              ? {}
              : { relevanceFloor: options.relevanceFloor }),
          },
        );

  return {
    repositories,
    budgets,
    async runResearch(ownerId, question, onSource) {
      currentOnSource = onSource;
      try {
        return await harness.run({ ownerId, question });
      } finally {
        currentOnSource = undefined;
      }
    },
    async answer(task, signal) {
      if (answers === undefined) throw new Error(NO_MODEL_MESSAGE);
      return answers.answer(task, signal);
    },
    async answerResponse(ownerId, question) {
      if (answers === undefined) throw new Error(NO_MODEL_MESSAGE);
      const outcome = await answers.answer({ ownerId, question });
      const stored = await repositories.answers.get(ownerId, outcome.answerId);
      if (stored === undefined) {
        throw new Error(`stored answer ${outcome.answerId} not found`);
      }
      return {
        requestId: outcome.requestId,
        answerId: outcome.answerId,
        cached: outcome.cached,
        degraded: outcome.degraded,
        evidenceOnly: outcome.evidenceOnly,
        ...(outcome.evidenceFromRun === undefined
          ? {}
          : { evidenceFromRun: outcome.evidenceFromRun }),
        blocks: stored.blocks,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        ...(outcome.reconciliation === undefined ? {} : { reconciliation: outcome.reconciliation }),
      };
    },
  };
}
