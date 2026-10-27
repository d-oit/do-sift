/** Public HTTP surface contracts for the research server. */
import type { MetricsRegistry } from "./metrics.js";
import type { OwnerLimits } from "./owner-limiter.js";
export interface SourceCard {
  url: string;
  title?: string | undefined;
  passageCount: number;
  /** SRC-14: the raw store-time similarity receipt (undefined without an
   * embedder) — data, not a verdict; see plans/003-004-src-ans.md SRC-14. */
  relevanceScore?: number | undefined;
  /** SRC-14: runtime decoration against the composition's floor — the UI
   * prominence verdict. Receipts are still shown, never hidden. */
  relevanceLow?: boolean | undefined;
}
export interface ResearchRunOutcome {
  hits: number;
  documentsStored: number;
  /** SRC-25: stored URLs reused instead of re-fetched this run. */
  documentsReused?: number | undefined;
  passagesStored: number;
  denied: number;
  fetchErrors: number;
  skippedBudget: number;
  /** SRC-17: per-provider sub-search outcomes (merged compositions only;
   * undefined for single-provider runs) — the health receipt on the SSE
   * done event, making survivor-degradation first-class. */
  providerHealth?: Array<{ provider: string; ok: boolean; error?: string | undefined }> | undefined;
}
export interface HttpRequestEvent {
  type: "http.request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  outcome: "success" | "client_error" | "server_error" | "unavailable" | "canceled";
  durationMs: number;
}
export interface AnswerSuspectEvent {
  type: "answer.suspect";
  requestId: string;
  passages: number;
  markers: string[];
}
export type OperationalEvent = HttpRequestEvent | AnswerSuspectEvent;
export interface ResearchServerOptions {
  /** #63: per-owner concurrency and request-rate limits (defaults apply when omitted). */
  ownerLimits?: OwnerLimits;
  /** CORE-04 AuthService-shaped: resolves the owner or throws AuthError. */
  auth: {
    authenticateOwner(request: {
      token?: string | undefined;
      clientAddress?: string | undefined;
    }): Promise<{ ownerId: string; via: string }>;
  };
  /** Runs the zero-LLM pipeline; calls onSource as each source lands. */
  runResearch: (
    ownerId: string,
    question: string,
    onSource: (source: SourceCard) => void,
    signal?: AbortSignal,
  ) => Promise<ResearchRunOutcome>;
  /** Structured, redacted request receipt; never receives body or auth headers. */
  onEvent?: ((event: OperationalEvent) => void) | undefined;
  /** Readiness dependency probe; omitted means the server is ready. */
  readiness?: (() => boolean | Promise<boolean>) | undefined;
  /**
   * Answer surface (ANS-05). When absent, POST /api/answer answers 501 —
   * the route is known but not wired. The payload carries the stored answer
   * blocks (citations resolve to stored evidence) plus the outcome flags;
   * rendering treats block text as data, never markup.
   */
  answer?:
    | ((ownerId: string, question: string, signal?: AbortSignal) => Promise<AnswerHttpResponse>)
    | undefined;
  /** Override for tests; defaults to the bundled source-card page. */
  pageHtml?: string;
  /** Request body cap in bytes; default 8192. */
  maxBodyBytes?: number;
  /** #67: when set, GET /metrics serves Prometheus text behind owner auth. */
  metrics?: MetricsRegistry | undefined;
}
export interface AnswerHttpResponse {
  requestId?: string | undefined;
  answerId: string;
  /** True on an exact-answer cache hit (nothing re-ran). */
  cached: boolean;
  /** True when the model's citations failed validation. */
  degraded: boolean;
  /** True when no model claims are present (evidence-only output). */
  evidenceOnly: boolean;
  /**
   * Evidence basis (ANS-07, R-15/F9): "run" = evidence came from a
   * completed research run for this question; "cross-question" = the
   * question's own run stored nothing and older corpus evidence was used;
   * "legacy" = pre-linkage evidence. Absent on the empty-evidence path.
   */
  evidenceFromRun?: "run" | "legacy" | "cross-question" | undefined;
  blocks: Array<{
    kind: "paragraph" | "list" | "caveat";
    text: string;
    citations: string[];
  }>;
  usage?:
    | {
        inputTokens: number;
        outputTokens: number;
        model: string;
        estimated: boolean;
      }
    | undefined;
  reconciliation?: { overrun: boolean; deltaInput: number; deltaOutput: number } | undefined;
  /**
   * ANS-12 advisory suspect receipt over the packed evidence (counts +
   * stable marker codes); absent on cache hits and empty-evidence answers.
   * Never degrades the answer by itself.
   */
  suspectEvidence?: { passages: number; markers: string[] } | undefined;
}
