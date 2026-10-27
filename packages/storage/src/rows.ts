/** Row shapes and row -> domain mappers for the storage repository (split from repositories.ts for the 500-line budget). */
import type { Row } from "@libsql/client";
export const now = (): string => new Date().toISOString();
export function str(row: Row, key: string): string {
  return String(row[key]);
}
export function strOrNull(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}
export function strOrUndefined(row: Row, key: string): string | undefined {
  const v = strOrNull(row, key);
  return v === null ? undefined : v;
}
export function numberOrUndefined(row: Row, key: string): number | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  const n = Number(row[key]);
  return Number.isNaN(n) ? undefined : n;
}
export interface OwnerRow {
  id: string;
  displayName: string;
  createdAt: string;
}
export interface DocumentInput {
  ownerId: string;
  canonicalUrl: string;
  originalUrl: string;
  contentHash: string;
  fetchedAt: string;
  publishedAt?: string | undefined;
  publishedOrigin?: DocumentOrigin | undefined;
  title?: string | undefined;
  rawMime?: string | undefined;
  rawText?: string | undefined;
  /** The research request that fetched this document (ANS-07); NULL = legacy. */
  requestId?: string | undefined;
  /**
   * Evidence relevance receipt (SRC-11): lead-window similarity computed
   * once per source at storage time. Advisory only — NULL/undefined =
   * legacy or unmeasured and is ALWAYS included; exclusion happens at
   * answer time (read-time floor), never at storage time.
   */
  relevanceScore?: number | undefined;
}
export type DocumentOrigin = "page-metadata" | "provider" | "domain-policy" | "user";
export interface DocumentRow {
  id: string;
  ownerId: string;
  canonicalUrl: string;
  originalUrl: string;
  contentHash: string;
  fetchedAt: string;
  publishedAt?: string | undefined;
  publishedOrigin?: DocumentOrigin | undefined;
  title?: string | undefined;
  rawMime?: string | undefined;
  rawText: string;
  createdAt: string;
  /** Research-run linkage (ANS-07); undefined when the row predates it. */
  requestId?: string | undefined;
  /** Relevance receipt (SRC-11); undefined = legacy/unmeasured (always included). */
  relevanceScore?: number | undefined;
}
export type PassageNoiseClass = "nav-list" | "reference" | "stub" | "fragment";
export interface PassageInput {
  ownerId: string;
  documentId: string;
  heading?: string | undefined;
  excerpt: string;
  extractionStatus: "ok" | "partial" | "failed";
  /** SRC-12 store-with-flag receipt: the noise class computed at store
   * time, or undefined (NULL = unclassified/legacy, always included). */
  noiseClass?: PassageNoiseClass | undefined;
}
export interface PassageRow {
  id: string;
  ownerId: string;
  documentId: string;
  heading?: string | undefined;
  excerpt: string;
  extractionStatus: "ok" | "partial" | "failed";
  noiseClass?: PassageNoiseClass | undefined;
  createdAt: string;
}
export interface AnswerBlocks {
  kind: "paragraph" | "list" | "caveat";
  text: string;
  citations: string[];
}
export interface AnswerUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  estimated: boolean;
}
export interface AnswerInput {
  ownerId: string;
  requestId: string;
  blocks: AnswerBlocks[];
  evidenceOnly: boolean;
  cacheKey?: string | undefined;
  usage?: AnswerUsage | undefined;
  promptRevision?: string | undefined;
  policyRevision?: string | undefined;
  modelRevision?: string | undefined;
  /** Evidence basis (ANS-07): 'run' | 'legacy' | 'cross-question'. */
  evidenceFromRun?: "run" | "legacy" | "cross-question" | undefined;
}
export interface AnswerRow {
  id: string;
  ownerId: string;
  requestId: string;
  blocks: AnswerBlocks[];
  evidenceOnly: boolean;
  cacheKey?: string | undefined;
  usage?: AnswerUsage | undefined;
  promptRevision: string;
  policyRevision: string;
  modelRevision: string;
  createdAt: string;
  /** Evidence basis (ANS-07); undefined on rows that predate it (= legacy). */
  evidenceFromRun?: "run" | "legacy" | "cross-question" | undefined;
}
export interface RequestRow {
  id: string;
  ownerId: string;
  mode: string;
  question: string;
  status: string;
  createdAt: string;
  completedAt?: string | undefined;
}
export interface FeedbackRow {
  id: string;
  rating: string;
  comment?: string | undefined;
  createdAt: string;
}
export interface EpisodeRow {
  id: string;
  question: string;
  summary: string;
  outcome: string;
  createdAt: string;
}
export interface JobRow {
  id: string;
  ownerId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "leased" | "done" | "dead";
  attempts: number;
  leaseUntil?: string | undefined;
  lastError?: string | undefined;
  updatedAt: string;
}
export interface UsageEntryInput {
  ownerId: string;
  requestId?: string | undefined;
  kind: "reservation" | "settlement";
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  searchCalls?: number | undefined;
  fetches?: number | undefined;
  /** UTC calendar day (YYYY-MM-DD) for daily caps. */
  day: string;
  state: "open" | "settled" | "expired";
}
export interface UsageEntryRow {
  id: string;
  ownerId: string;
  requestId?: string | undefined;
  kind: "reservation" | "settlement";
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  fetches: number;
  day: string;
  state: "open" | "settled" | "expired";
  createdAt: string;
}
export function documentFromRow(row: Row): DocumentRow {
  return {
    id: str(row, "id"),
    ownerId: str(row, "owner_id"),
    canonicalUrl: str(row, "canonical_url"),
    originalUrl: str(row, "original_url"),
    contentHash: str(row, "content_hash"),
    fetchedAt: str(row, "fetched_at"),
    publishedAt: strOrUndefined(row, "published_at"),
    publishedOrigin: strOrUndefined(row, "published_origin") as DocumentOrigin | undefined,
    title: strOrUndefined(row, "title"),
    rawMime: strOrUndefined(row, "raw_mime"),
    rawText: str(row, "raw_text"),
    createdAt: str(row, "created_at"),
    requestId: strOrUndefined(row, "request_id"),
    relevanceScore: numberOrUndefined(row, "relevance_score"),
  };
}
export function passageFromRow(row: Row): PassageRow {
  return {
    id: str(row, "id"),
    ownerId: str(row, "owner_id"),
    documentId: str(row, "document_id"),
    heading: strOrUndefined(row, "heading"),
    excerpt: str(row, "excerpt"),
    extractionStatus: str(row, "extraction_status") as PassageRow["extractionStatus"],
    noiseClass: (strOrUndefined(row, "noise_class") ?? undefined) as PassageNoiseClass | undefined,
    createdAt: str(row, "created_at"),
  };
}
export function answerFromRow(row: Row): AnswerRow {
  const usage: AnswerUsage | undefined =
    row.usage_model === null
      ? undefined
      : {
          inputTokens: Number(row.usage_input_tokens),
          outputTokens: Number(row.usage_output_tokens),
          model: str(row, "usage_model"),
          estimated: Number(row.usage_estimated) === 1,
        };
  const cacheKey = strOrUndefined(row, "cache_key");
  return {
    id: str(row, "id"),
    ownerId: str(row, "owner_id"),
    requestId: str(row, "request_id"),
    blocks: JSON.parse(str(row, "blocks_json")) as AnswerBlocks[],
    evidenceOnly: Number(row.evidence_only) === 1,
    cacheKey,
    usage,
    promptRevision: str(row, "prompt_revision"),
    policyRevision: str(row, "policy_revision"),
    modelRevision: str(row, "model_revision"),
    createdAt: str(row, "created_at"),
    evidenceFromRun: strOrUndefined(row, "evidence_from_run") as AnswerRow["evidenceFromRun"],
  };
}
