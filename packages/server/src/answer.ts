/**
 * Answer service (ANS-03/ANS-04, plan 004). The one bounded synthesis call
 * (ADR 0006) with the citation gate that makes "research with receipts"
 * honest:
 *
 *   retrieve (FTS5 baseline, owner-scoped) → exact-answer cache lookup
 *   (owner + normalized question + mode + source versions + revisions;
 *   hit = zero model calls, zero budget) → pack passages under the input
 *   ceiling → budget reserve → one model call (cancellation-aware) →
 *   validate every citation against the passages ACTUALLY SENT → on any
 *   invalid citation degrade to evidence-only, no repair loop → store with
 *   cache key + revisions → settle the budget and reconcile actual usage
 *   against the reservation (overruns reported, never hidden).
 *
 * Passing validation is existence, not entailment (ADR 0003/R-06). Prompt
 * packing is minimal (ANS-02's adapter refines it).
 */
import {
  buildCacheKey,
  CitationError,
  estimateTokens,
  validateCitations,
  type Answer,
  type ModelProvider,
  type SynthesisRequest,
} from "@do-sift/contracts";
import type { Client } from "@libsql/client";
import { searchPassages, type BudgetService, type Repositories } from "@do-sift/storage";

export interface AnswerRevisions {
  policyRevision?: string;
  promptRevision?: string;
  modelRevision?: string;
}

export interface AnswerServiceOptions {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxPassages?: number;
  /** Cache-key revision inputs (D5/plan 000: revision change = cache miss). */
  revisions?: AnswerRevisions;
}

export interface AnswerServiceDeps {
  client: Client;
  repositories: Repositories;
  /** The model path (ANS-01 router satisfies this structurally). */
  model: ModelProvider;
  budget?: BudgetService | undefined;
}

export interface AnswerTask {
  ownerId: string;
  question: string;
}

export interface UsageReconciliation {
  overrun: boolean;
  deltaInput: number;
  deltaOutput: number;
}

export interface AnswerOutcome {
  requestId: string | undefined;
  answerId: string;
  /** True on an exact-answer cache hit (nothing re-ran). */
  cached: boolean;
  /** True when the model's citations failed validation (or no evidence). */
  degraded: boolean;
  /** True when no model claims are present (evidence-only output). */
  evidenceOnly: boolean;
  usage?: Answer["usage"] | undefined;
  /** Settle-time reconciliation of actual usage vs the reservation. */
  reconciliation?: UsageReconciliation | undefined;
}

const DEFAULTS = { maxInputTokens: 4000, maxOutputTokens: 700, maxPassages: 6 };
const OUTPUT_HEADROOM_TOKENS = 24;

export class AnswerCancelledError extends Error {
  constructor() {
    super("aborted before or during the answer path");
    this.name = "AnswerCancelledError";
  }
}

function packPassages(
  question: string,
  passages: Array<{ id: string; text: string }>,
  maxInputTokens: number,
): Array<{ id: string; text: string }> {
  const packed = [...passages];
  while (
    packed.length > 1 &&
    estimateTokens([question, ...packed.map((p) => p.text)].join(" ")) + OUTPUT_HEADROOM_TOKENS >
      maxInputTokens
  ) {
    packed.pop();
  }
  return packed;
}

function evidenceOnlyAnswer(
  ownerId: string,
  question: string,
  passages: Array<{ id: string; text: string }>,
): Answer {
  return {
    ownerId,
    question,
    blocks: passages.map((p) => ({
      kind: "paragraph" as const,
      text: p.text,
      citations: [p.id], // self-citation: the passage itself is the receipt
    })),
    evidenceOnly: true,
  };
}

export function createAnswerService(deps: AnswerServiceDeps, options: AnswerServiceOptions = {}) {
  const maxInputTokens = options.maxInputTokens ?? DEFAULTS.maxInputTokens;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
  const maxPassages = options.maxPassages ?? DEFAULTS.maxPassages;
  const revisions = {
    policyRevision: options.revisions?.policyRevision ?? "p0",
    promptRevision: options.revisions?.promptRevision ?? "pr0",
    modelRevision: options.revisions?.modelRevision ?? "m0",
  };

  /** Cache key from the exact-answer inputs (D5); source versions are the
   * retrieved documents' content hashes — new evidence = new answer. */
  function cacheKeyFor(ownerId: string, question: string, sourceVersions: string[]): string {
    return buildCacheKey({
      ownerId,
      question,
      mode: "answer",
      language: "en",
      sourceVersions,
      policyRevision: revisions.policyRevision,
      promptRevision: revisions.promptRevision,
      modelRevision: revisions.modelRevision,
    });
  }

  return {
    async answer(task: AnswerTask, signal?: AbortSignal): Promise<AnswerOutcome> {
      if (signal?.aborted) throw new AnswerCancelledError();

      const retrieved = await searchPassages(deps.client, task.ownerId, task.question, maxPassages);
      const sourceVersions = [...new Set(retrieved.map((p) => p.contentHash))].sort();
      const cacheKey = cacheKeyFor(task.ownerId, task.question, sourceVersions);

      // ---- exact-answer cache: a hit reruns nothing (D5) ----
      const cached = await deps.repositories.answers.findByCacheKey(task.ownerId, cacheKey);
      if (cached) {
        return {
          requestId: undefined,
          answerId: cached.id,
          cached: true,
          degraded: cached.evidenceOnly,
          evidenceOnly: cached.evidenceOnly,
          usage: cached.usage,
        };
      }

      const requestId = await deps.repositories.requests.create(
        task.ownerId,
        "answer",
        task.question,
      );

      // no evidence → honest empty evidence-only answer, zero model calls
      if (retrieved.length === 0) {
        const answer = evidenceOnlyAnswer(task.ownerId, task.question, []);
        const answerId = await deps.repositories.answers.insert({
          ownerId: task.ownerId,
          requestId,
          blocks: answer.blocks,
          evidenceOnly: true,
          cacheKey,
        });
        await deps.repositories.requests.complete(task.ownerId, requestId);
        return { requestId, answerId, cached: false, degraded: true, evidenceOnly: true };
      }

      const packed = packPassages(
        task.question,
        retrieved.map((p) => ({ id: p.passageId, text: p.excerpt })),
        maxInputTokens,
      );
      const request: SynthesisRequest = {
        question: task.question,
        passages: packed,
        followUps: [],
        maxInputTokens,
        maxOutputTokens,
      };

      let reservationId: string | undefined;
      if (deps.budget !== undefined) {
        const { id } = await deps.budget.reserve({
          ownerId: task.ownerId,
          requestId,
          request: {
            maxInputTokens,
            maxOutputTokens,
            maxSearchCalls: 0,
            maxFetches: 0,
            deadlineMs: 30_000,
          },
          estimatedInputTokens: estimateTokens(
            [task.question, ...packed.map((p) => p.text)].join(" "),
          ),
          nowMs: Date.now(),
        });
        reservationId = id;
      }

      let answer: Answer;
      let degraded = false;
      let actual: { inputTokens: number; outputTokens: number } | undefined;
      let reconciliation: UsageReconciliation | undefined;
      try {
        if (signal?.aborted) throw new AnswerCancelledError();
        const draft = await deps.model.complete(request, signal);
        actual = { inputTokens: draft.usage.inputTokens, outputTokens: draft.usage.outputTokens };
        answer = {
          ownerId: task.ownerId,
          question: task.question,
          blocks: draft.blocks,
          usage: draft.usage,
          evidenceOnly: false,
        };
        try {
          // the model may only cite evidence it was actually given
          validateCitations(answer, new Set(packed.map((p) => p.id)));
        } catch (e) {
          if (!(e instanceof CitationError)) throw e;
          degraded = true; // no repair loop: degrade to evidence-only
          answer = evidenceOnlyAnswer(task.ownerId, task.question, packed);
        }
      } catch (e) {
        if (deps.budget !== undefined && reservationId !== undefined) {
          // model call failed before/without usage: settle zeros, honestly
          await deps.budget
            .settle({
              ownerId: task.ownerId,
              reservationId,
              actual: { inputTokens: 0, outputTokens: 0 },
              nowMs: Date.now(),
            })
            .catch(() => {});
        }
        await deps.repositories.requests.fail(task.ownerId, requestId);
        throw e;
      }

      const answerId = await deps.repositories.answers.insert({
        ownerId: task.ownerId,
        requestId,
        blocks: answer.blocks,
        evidenceOnly: answer.evidenceOnly,
        cacheKey,
        usage: answer.usage
          ? {
              inputTokens: answer.usage.inputTokens,
              outputTokens: answer.usage.outputTokens,
              model: answer.usage.model,
              estimated: answer.usage.estimated,
            }
          : undefined,
        promptRevision: revisions.promptRevision,
        policyRevision: revisions.policyRevision,
        modelRevision: revisions.modelRevision,
      });
      await deps.repositories.requests.complete(task.ownerId, requestId);

      if (deps.budget !== undefined && reservationId !== undefined) {
        const settled = await deps.budget.settle({
          ownerId: task.ownerId,
          reservationId,
          actual: actual ?? { inputTokens: 0, outputTokens: 0 },
          nowMs: Date.now(),
        });
        reconciliation = {
          overrun: settled.overrun,
          deltaInput: settled.deltaInput,
          deltaOutput: settled.deltaOutput,
        };
      }

      return {
        requestId,
        answerId,
        cached: false,
        degraded,
        evidenceOnly: answer.evidenceOnly,
        usage: answer.usage,
        reconciliation,
      };
    },
  };
}
