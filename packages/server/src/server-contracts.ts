/** Public HTTP surface contracts for the research server. */
import type { TenantMemberChange, TenantRole } from "@do-sift/contracts";
import type { MetricsRegistry } from "./metrics.js";
import type { OwnerLimits } from "./owner-limiter.js";
import type { PrincipalRuntimeRequest } from "./runtime-resolver.js";
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
/** Honest-degradation receipt: every degraded answer names why it degraded. */
export interface AnswerDegradedEvent {
  type: "answer.degraded";
  requestId: string;
  /** No evidence, unresolved model citations, or the model provider failed. */
  reason: "no-evidence" | "citation-invalid" | "model-failed";
}
export type OperationalEvent = HttpRequestEvent | AnswerSuspectEvent | AnswerDegradedEvent;
/**
 * The authenticated caller of one request (issue #120). `tenantId` is the
 * tenant the provider resolved — never a caller-supplied value — and is absent
 * only for the pre-multi-tenant allowlist posture, which has no tenant
 * routing.
 */
export interface AuthenticatedRequestOwner {
  ownerId: string;
  via: string;
  tenantId?: string | undefined;
}
/**
 * The run surface for one tenant (issue #120, MT-07). A multi-tenant process
 * hands these back per request from `runtimeFor`, so one listener can serve
 * several tenants while each request only ever touches its own runtime.
 */
export interface RuntimeHandlers {
  runResearch: (
    ownerId: string,
    question: string,
    onSource: (source: SourceCard) => void,
    signal?: AbortSignal,
  ) => Promise<ResearchRunOutcome>;
  answer?:
    | ((ownerId: string, question: string, signal?: AbortSignal) => Promise<AnswerHttpResponse>)
    | undefined;
}
/**
 * Read-only views of what a tenant has already stored (issue #120, MT-13).
 * They carry provenance and identity only — never raw page text, prompts, or
 * model payloads — so a read-only role can review the corpus without turning
 * the API into a bulk export of fetched content.
 */
export interface EvidenceView {
  id: string;
  /** Canonical URL of the stored source. */
  url: string;
  title?: string | undefined;
  /** When the source was fetched (not when the row was written). */
  fetchedAt: string;
}

/** One stored answer as the read surface lists it (id, question, flags). */
export interface AnswerSummaryView {
  id: string;
  /** The question that produced the answer (from its own request row). */
  question: string;
  evidenceOnly: boolean;
  createdAt: string;
}

/**
 * The `(timestamp, id)` of the last row a caller received, used to continue a
 * page (issue #120, MT-14). Rows are selected strictly older than this pair, so
 * paging stays stable when many rows share a timestamp.
 */
export interface ReadCursor {
  at: string;
  id: string;
}

/**
 * Read handlers bound to one tenant by the host (see `readFor`). `limit` is the
 * page size the server asks for — one more than the caller's `limit` when it
 * needs to know whether another page exists — and `before` continues a page.
 */
export interface ReadHandlers {
  evidence(ownerId: string, limit: number, before?: ReadCursor): Promise<EvidenceView[]>;
  answers(ownerId: string, limit: number, before?: ReadCursor): Promise<AnswerSummaryView[]>;
}

/** One membership row as the admin surface returns it (never a secret). */
export interface TenantMemberView {
  userId: string;
  role: TenantRole;
  createdAt?: string | undefined;
}
/** One recorded membership change, as the owner-only history route returns it. */
export type TenantMemberChangeView = TenantMemberChange;
/**
 * Membership administration backed by stored state (issue #120, MT-09/MT-10).
 *
 * `roleOf` exists so the server layer can authorize by the *recorded* role
 * instead of importing a storage type or trusting a token claim. Handlers
 * receive the caller's own tenant id; they must never accept one from a
 * request.
 */
export interface MembershipAdminHandlers {
  /** Stored role of a user in the tenant; undefined means "not a member". */
  roleOf(tenantId: string, userId: string): Promise<TenantRole | undefined>;
  /** Every membership row of the tenant. */
  list(tenantId: string): Promise<TenantMemberView[]>;
  /**
   * Add or re-role a membership (create-if-absent), recording `actorUserId`
   * as the author of the change.
   */
  upsert(tenantId: string, userId: string, role: TenantRole, actorUserId: string): Promise<void>;
  /**
   * Drop a membership, recording `actorUserId`; resolves false when there was
   * nothing to remove (and then records nothing).
   */
  remove(tenantId: string, userId: string, actorUserId: string): Promise<boolean>;
  /** Recent changes of the tenant, newest first (bounded by the host). */
  changes(tenantId: string): Promise<TenantMemberChangeView[]>;
}
export interface ResearchServerOptions {
  /** #63: per-owner concurrency and request-rate limits (defaults apply when omitted). */
  ownerLimits?: OwnerLimits;
  /** CORE-04 AuthService-shaped: resolves the owner or throws AuthError. */
  auth: {
    authenticateOwner(request: {
      token?: string | undefined;
      clientAddress?: string | undefined;
    }): Promise<AuthenticatedRequestOwner>;
  };
  /** Runs the zero-LLM pipeline; calls onSource as each source lands. */
  runResearch?: (
    ownerId: string,
    question: string,
    onSource: (source: SourceCard) => void,
    signal?: AbortSignal,
  ) => Promise<ResearchRunOutcome>;
  /**
   * Per-request runtime selection (issue #120, MT-07). When set it replaces
   * `runResearch`/`answer` and is called with the authenticated principal's
   * `(tenantId, userId)`; the default-tenant id is used when the provider
   * reports no tenant. Throwing `TenantAccessError` answers 403.
   */
  runtimeFor?: ((principal: PrincipalRuntimeRequest) => Promise<RuntimeHandlers>) | undefined;
  /**
   * Read-only views of the caller's own stored data (issue #120, MT-13). When
   * set, `GET /api/evidence` and `GET /api/answers` list the authenticated
   * owner's newest rows inside their tenant. `read` is the one action every
   * recorded role has, so a `viewer` can use these routes; when `roleFor` is
   * also set, a caller without a recorded membership is refused. Absent →
   * both paths answer 404 (the pre-MT-13 surface).
   */
  readFor?: ((principal: PrincipalRuntimeRequest) => Promise<ReadHandlers>) | undefined;
  /**
   * Recorded role of the caller in their tenant (issue #120, MT-12). When set,
   * the billable run surfaces consult it before the runtime is resolved: a
   * role that does not permit `research` — a read-only `viewer`, or no
   * membership at all — answers 403 without reserving budget, writing
   * evidence, or building a runtime. Absent → no role gate (the single-tenant
   * allowlist posture, unchanged from before MT-12).
   */
  roleFor?: ((principal: PrincipalRuntimeRequest) => Promise<TenantRole | undefined>) | undefined;
  /**
   * Membership administration (issue #120, MT-09). When set, an authenticated
   * recorded `owner` of their own tenant may list, add, re-role, and remove
   * members at `/api/admin/members[/<userId>]` and read the change log at
   * `/api/admin/member-changes`. Absent (single-tenant hosts, the default) →
   * those paths answer 404.
   */
  membershipAdmin?: MembershipAdminHandlers | undefined;
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
  /**
   * Why the answer degraded: no evidence could be packed, the model's
   * citations did not resolve, or the model provider failed. Absent on
   * grounded answers (and on cache hits, which are only grounded or
   * no-evidence).
   */
  degradationReason?: "no-evidence" | "citation-invalid" | "model-failed" | undefined;
  blocks: Array<{
    kind: "paragraph" | "list" | "caveat";
    text: string;
    citations: string[];
    /** Claim-level honesty flag: its citations did not resolve. */
    unresolved?: boolean | undefined;
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
