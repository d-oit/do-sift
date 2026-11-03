/** Answer service contracts: options/deps, outcome shapes, defaults, and the cancellation error. */
import { type Answer, type EvidenceMarker, type ModelProvider } from "@do-sift/contracts";
import type { Client } from "@libsql/client";
import { type BudgetService, type Repositories, type TextEmbedder } from "@do-sift/storage";
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
  /**
   * SRC-11 answer-time exclusion floor: documents scored below it are
   * advisory-excluded from the pool; NO score (NULL = legacy/unmeasured)
   * is ALWAYS included. Read-time tunable — NOT a cache-key input (source
   * versions are unchanged content hashes, revisions unchanged), so no
   * policyRevision bump.
   */
  relevanceFloor?: number;
  /**
   * SRC-12 answer-time exclusion of noise-classified passages (nav-list /
   * reference / stub, flagged at store time). Designed behavior is on;
   * the option exists for read-time tunability like the floor. NOTE: the
   * DEFAULT CHANGE from off-to-on IS a packing-semantics change and IS
   * accompanied by the p1 → p2 policyRevision bump below (the packed
   * passage set can change under an identical sourceVersions set when a
   * document carries both clean and flagged chunks — D5 conservatism).
   */
  noiseFilter?: boolean;
}
export interface AnswerServiceDeps {
  client: Client;
  repositories: Repositories;
  /** The model path (ANS-01 router satisfies this structurally). */
  model: ModelProvider;
  budget?: BudgetService | undefined;
  /**
   * When provided, retrieval fuses bm25 ranks with cosine ranks over stored
   * embeddings (RET-02, ADR 0009); without it, plain bm25 (unchanged).
   */
  embedder?: TextEmbedder | undefined;
  /**
   * Synthesis audit hook (issue #123, plan 038 — EXT-03). Called once per
   * synthesis attempt, after the call settles, with what actually happened.
   * Best-effort at the call site: a throwing logger is swallowed so a logging
   * failure can never lose an answer that was already produced and settled.
   * The caller decides what to persist (e.g. `SynthesisCallLogService`).
   */
  onSynthesis?: ((event: SynthesisAuditEvent) => void | Promise<void>) | undefined;
}

/**
 * One synthesis attempt, reported to `AnswerServiceDeps.onSynthesis`.
 * Token counts and cost are the CALL's, not the reservation's: on failure there
 * is no usage to report and `outcome` says so.
 */
export interface SynthesisAuditEvent {
  /** Tenant the runtime serving this call is bound to (never caller input). */
  tenantId: string;
  ownerId: string;
  requestId: string | undefined;
  answerId: string | undefined;
  /** Contract identity of the model path (the router reports its selection). */
  provider: string;
  model: string;
  estimated: boolean;
  inputTokens: number;
  outputTokens: number;
  outcome: "completed" | "failed";
  /** Failure class name when `outcome` is "failed". */
  failureKind?: string | undefined;
  /** True when the call was refused before reaching the provider (budget, abort). */
  at: string;
}
export interface AnswerTask {
  ownerId: string;
  question: string;
}
export type DegradationReason = "no-evidence" | "citation-invalid" | "model-failed";
export interface UsageReconciliation {
  overrun: boolean;
  deltaInput: number;
  deltaOutput: number;
}
export interface SuspectReceipt {
  passages: number;
  markers: EvidenceMarker[];
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
  /** Why the answer degraded; absent on grounded answers and cache hits of them. */
  degradationReason?: DegradationReason | undefined;
  /**
   * Evidence basis (ANS-07, R-15/F9): "run" = at least one packed passage
   * came from a COMPLETED research run for this owner+question;
   * "cross-question" = the evidence belongs to other questions' runs —
   * the honest signal that this question's own run stored nothing;
   * "legacy" = pre-ANS-07 evidence with no run linkage. Undefined on the
   * empty-evidence path (nothing was retrieved at all).
   */
  evidenceFromRun?: "run" | "legacy" | "cross-question" | undefined;
  usage?: Answer["usage"] | undefined;
  /** Settle-time reconciliation of actual usage vs the reservation. */
  reconciliation?: UsageReconciliation | undefined;
  /**
   * ANS-12 advisory suspect receipt over the PACKED evidence (run path
   * only, like `reconciliation`; absent on cache hits and the empty-
   * evidence path). Never degrades an answer by itself.
   */
  suspectEvidence?: SuspectReceipt | undefined;
}
export const DEFAULT_RELEVANCE_FLOOR = 0.7;
export const DEFAULTS = {
  maxInputTokens: 4000,
  maxOutputTokens: 700,
  maxPassages: 6,
  relevanceFloor: DEFAULT_RELEVANCE_FLOOR,
  // SRC-12 designed behavior: noise-classified passages never pack.
  noiseFilter: true,
};
export class AnswerCancelledError extends Error {
  constructor() {
    super("aborted before or during the answer path");
    this.name = "AnswerCancelledError";
  }
}
