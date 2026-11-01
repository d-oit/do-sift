/** Answer service. Contracts live in answer-contracts.ts, pure helpers in answer-evidence.ts. */
import {
  buildCacheKey,
  CitationError,
  estimateTokens,
  normalizeQuestion,
  validateCitations,
  type Answer,
  type SynthesisRequest,
} from "@do-sift/contracts";
import { hybridSearch, searchPassages, type PassageHit } from "@do-sift/storage";
import { AnswerCancelledError, DEFAULTS } from "./answer-contracts.js";
import type {
  AnswerOutcome,
  AnswerServiceDeps,
  AnswerServiceOptions,
  AnswerTask,
  UsageReconciliation,
} from "./answer-contracts.js";
import { detectSuspects, evidenceOnlyAnswer, packPassages } from "./answer-evidence.js";
export type { AnswerRevisions } from "./answer-contracts.js";
export type { AnswerServiceOptions } from "./answer-contracts.js";
export type { AnswerServiceDeps } from "./answer-contracts.js";
export type { AnswerTask } from "./answer-contracts.js";
export type { UsageReconciliation } from "./answer-contracts.js";
export type { SuspectReceipt } from "./answer-contracts.js";
export type { AnswerOutcome } from "./answer-contracts.js";
export { DEFAULT_RELEVANCE_FLOOR } from "./answer-contracts.js";
export { AnswerCancelledError } from "./answer-contracts.js";
export function createAnswerService(deps: AnswerServiceDeps, options: AnswerServiceOptions = {}) {
  const maxInputTokens = options.maxInputTokens ?? DEFAULTS.maxInputTokens;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
  const maxPassages = options.maxPassages ?? DEFAULTS.maxPassages;
  const relevanceFloor = options.relevanceFloor ?? DEFAULTS.relevanceFloor;
  const noiseFilter = options.noiseFilter ?? DEFAULTS.noiseFilter;
  const revisions = {
    // p4: SRC-21 — the classifier also flags bracketed-citation entries,
    // code-comment shards, and lowercase-start shards, so the packed
    // passage set can change under an identical sourceVersions set (D5
    // conservatism). (p3: SRC-18 — fragment chunks; p2: SRC-12 —
    // noise-classified passages excluded from packing; p1: ANS-08 —
    // retrieval became question-scoped.)
    policyRevision: options.revisions?.policyRevision ?? "p4",
    // pr2: ANS-11 — evidence packs as neutralized JSON records, a
    // different prompt than pr1's `[id] text` lines; the bump (D5)
    // invalidates pre-ANS-11 cache rows. (pr1: ANS-02 packing semantics.)
    promptRevision: options.revisions?.promptRevision ?? "pr2",
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

  /** ANS-07 evidence basis over the retrieved passages: does ANY of them
   * belong to a completed research run for this owner+question? Legacy
   * (unlinked) documents are never counted as from-run. */
  async function evidenceBasis(
    ownerId: string,
    question: string,
    documentIds: string[],
  ): Promise<"run" | "legacy" | "cross-question"> {
    const links = await deps.repositories.documents.linkByDocumentId(ownerId, documentIds);
    const wanted = new Set(
      (await deps.repositories.requests.completedSearches(ownerId))
        .filter((r) => normalizeQuestion(r.question) === normalizeQuestion(question))
        .map((r) => r.id),
    );
    const bases = documentIds.map((id) => links[id] ?? null);
    if (bases.some((reqId) => reqId !== null && wanted.has(reqId))) return "run";
    if (bases.some((reqId) => reqId === null)) return "legacy";
    return "cross-question";
  }

  return {
    async answer(task: AnswerTask, signal?: AbortSignal): Promise<AnswerOutcome> {
      if (signal?.aborted) throw new AnswerCancelledError();

      // ANS-08: scope candidates to this question's completed runs when
      // any exist; otherwise fall back to the whole owner corpus.
      const ownRunIds = (await deps.repositories.requests.completedSearches(task.ownerId))
        .filter((r) => normalizeQuestion(r.question) === normalizeQuestion(task.question))
        .map((r) => r.id);
      let scopedDocIds: string[] | undefined;
      if (ownRunIds.length > 0) {
        const scoped = await deps.repositories.documents.idsByRequestIds(task.ownerId, ownRunIds);
        if (scoped.length > 0) scopedDocIds = scoped;
      }

      // #120: retrieval is tenant-scoped, so the answer path can never read
      // another tenant's evidence even with a colliding owner id.
      const tenantId = deps.repositories.tenantId;
      let retrieved: PassageHit[] =
        scopedDocIds !== undefined
          ? deps.embedder === undefined
            ? await searchPassages(
                deps.client,
                task.ownerId,
                task.question,
                maxPassages,
                scopedDocIds,
                relevanceFloor,
                noiseFilter,
                tenantId,
              )
            : await hybridSearch(
                deps.client,
                task.ownerId,
                task.question,
                maxPassages,
                deps.embedder,
                scopedDocIds,
                relevanceFloor,
                noiseFilter,
                tenantId,
              )
          : deps.embedder === undefined
            ? await searchPassages(
                deps.client,
                task.ownerId,
                task.question,
                maxPassages,
                undefined,
                relevanceFloor,
                noiseFilter,
                tenantId,
              )
            : await hybridSearch(
                deps.client,
                task.ownerId,
                task.question,
                maxPassages,
                deps.embedder,
                undefined,
                relevanceFloor,
                noiseFilter,
                tenantId,
              );

      if (scopedDocIds !== undefined && retrieved.length === 0) {
        // the floor emptied the scoped pool: re-include own-run docs without the floor
        // (SRC-12 note: the noise filter STAYS on — the fallback exists for the
        // floor's false negatives on on-topic evidence, not for noise)
        retrieved =
          deps.embedder === undefined
            ? await searchPassages(
                deps.client,
                task.ownerId,
                task.question,
                maxPassages,
                scopedDocIds,
                undefined,
                noiseFilter,
                tenantId,
              )
            : await hybridSearch(
                deps.client,
                task.ownerId,
                task.question,
                maxPassages,
                deps.embedder,
                scopedDocIds,
                undefined,
                noiseFilter,
                tenantId,
              );
      }

      const sourceVersions = [...new Set(retrieved.map((p) => p.contentHash))].sort();
      const cacheKey = cacheKeyFor(task.ownerId, task.question, sourceVersions);
      const basis =
        retrieved.length === 0
          ? undefined
          : await evidenceBasis(
              task.ownerId,
              task.question,
              retrieved.map((p) => p.documentId),
            );

      // ---- exact-answer cache: a hit reruns nothing (D5) ----
      const cached = await deps.repositories.answers.findByCacheKey(task.ownerId, cacheKey);
      if (cached) {
        return {
          requestId: undefined,
          answerId: cached.id,
          cached: true,
          degraded: cached.evidenceOnly,
          evidenceOnly: cached.evidenceOnly,
          evidenceFromRun: cached.evidenceFromRun ?? "legacy",
          usage: cached.usage,
        };
      }

      const requestId = await deps.repositories.requests.create(
        task.ownerId,
        "answer",
        task.question,
      );

      let reservationId: string | undefined;
      let actual: { inputTokens: number; outputTokens: number } | undefined;
      let reservationSettled = false;

      try {
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
          return {
            requestId,
            answerId,
            cached: false,
            degraded: true,
            evidenceOnly: true,
            evidenceFromRun: undefined,
          };
        }

        const packed = packPassages(
          task.question,
          retrieved.map((p) => ({ id: p.passageId, text: p.excerpt })),
          maxInputTokens,
          maxOutputTokens,
        );
        const suspect = detectSuspects(packed);
        const request: SynthesisRequest = {
          question: task.question,
          passages: packed,
          followUps: [],
          maxInputTokens,
          maxOutputTokens,
        };

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

        const answerId = await deps.repositories.answers.insert({
          ownerId: task.ownerId,
          requestId,
          blocks: answer.blocks,
          evidenceOnly: answer.evidenceOnly,
          cacheKey: degraded ? undefined : cacheKey,
          evidenceFromRun: basis,
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

        let reconciliation: UsageReconciliation | undefined;
        if (deps.budget !== undefined && reservationId !== undefined) {
          const settled = await deps.budget.settle({
            ownerId: task.ownerId,
            reservationId,
            actual: actual ?? { inputTokens: 0, outputTokens: 0 },
            nowMs: Date.now(),
          });
          reservationSettled = true;
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
          evidenceFromRun: basis,
          usage: answer.usage,
          reconciliation,
          suspectEvidence: suspect,
        };
      } catch (e) {
        if (deps.budget !== undefined && reservationId !== undefined && !reservationSettled) {
          await deps.budget
            .settle({
              ownerId: task.ownerId,
              reservationId,
              actual: actual ?? { inputTokens: 0, outputTokens: 0 },
              nowMs: Date.now(),
            })
            .catch(() => {});
        }
        await deps.repositories.requests.fail(task.ownerId, requestId).catch(() => {});
        throw e;
      }
    },
  };
}
