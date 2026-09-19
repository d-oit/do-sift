/**
 * Owner-scoped repositories (CORE-03, ADR 0003). Every read and write
 * filters on owner_id: cross-owner access is structurally impossible
 * through this layer because no method accepts an id without its owner.
 * Rows map snake_case columns to camelCase fields; ids are UUIDs unless
 * the caller supplies one.
 */
import { randomUUID } from "node:crypto";
import type { Client, Row } from "@libsql/client";

const now = (): string => new Date().toISOString();

function str(row: Row, key: string): string {
  return String(row[key]);
}
function strOrNull(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}
function strOrUndefined(row: Row, key: string): string | undefined {
  const v = strOrNull(row, key);
  return v === null ? undefined : v;
}
function numberOrUndefined(row: Row, key: string): number | undefined {
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

function documentFromRow(row: Row): DocumentRow {
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

function passageFromRow(row: Row): PassageRow {
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

function answerFromRow(row: Row): AnswerRow {
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

function jobFromRow(row: Row): JobRow {
  return {
    id: str(row, "id"),
    ownerId: str(row, "owner_id"),
    kind: str(row, "kind"),
    payload: JSON.parse(str(row, "payload_json")) as Record<string, unknown>,
    status: str(row, "status") as JobRow["status"],
    attempts: Number(row.attempts),
    leaseUntil: strOrUndefined(row, "lease_until"),
    lastError: strOrUndefined(row, "last_error"),
    updatedAt: str(row, "updated_at"),
  };
}

export class Repositories {
  constructor(private readonly client: Client) {}

  /** Raw client for storage-adjacent tooling (e.g. embedding backfill, RET-02). */
  get db(): Client {
    return this.client;
  }

  readonly owners = {
    ensure: async (id: string, displayName: string): Promise<void> => {
      await this.client.execute({
        sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [id, displayName, now()],
      });
    },
    get: async (id: string): Promise<OwnerRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM owners WHERE id = ?",
        args: [id],
      });
      const row = res.rows[0];
      if (!row) return undefined;
      return {
        id: str(row, "id"),
        displayName: str(row, "display_name"),
        createdAt: str(row, "created_at"),
      };
    },
  };

  readonly documents = {
    insert: async (d: DocumentInput): Promise<string> => {
      const id = randomUUID();
      // ANS-07: if a request linkage is supplied, it must belong to the
      // same owner (the FK alone does not check ownership).
      if (d.requestId !== undefined) {
        const req = await this.requests.get(d.ownerId, d.requestId);
        if (!req) {
          throw new Error(`document references request ${d.requestId} not owned by ${d.ownerId}`);
        }
      }
      await this.client.execute({
        sql: `INSERT INTO documents (id, owner_id, canonical_url, original_url, content_hash, fetched_at,
               published_at, published_origin, title, raw_mime, raw_text, request_id, relevance_score, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          d.ownerId,
          d.canonicalUrl,
          d.originalUrl,
          d.contentHash,
          d.fetchedAt,
          d.publishedAt ?? null,
          d.publishedOrigin ?? null,
          d.title ?? null,
          d.rawMime ?? null,
          d.rawText ?? "",
          d.requestId ?? null,
          d.relevanceScore ?? null,
          now(),
        ],
      });
      return id;
    },
    get: async (ownerId: string, id: string): Promise<DocumentRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM documents WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      const row = res.rows[0];
      return row ? documentFromRow(row) : undefined;
    },
    list: async (ownerId: string, limit = 50): Promise<DocumentRow[]> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM documents WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [ownerId, limit],
      });
      return res.rows.map(documentFromRow);
    },
    /** ANS-08: document ids linked to the given research request ids. */
    idsByRequestIds: async (ownerId: string, requestIds: string[]): Promise<string[]> => {
      if (requestIds.length === 0) return [];
      const placeholders = requestIds.map(() => "?").join(", ");
      const res = await this.client.execute({
        sql: `SELECT id FROM documents WHERE owner_id = ? AND request_id IN (${placeholders})`,
        args: [ownerId, ...requestIds],
      });
      return res.rows.map((row) => String(row.id));
    },
    /** ANS-07: research-run linkage per document id (owner-scoped). */
    linkByDocumentId: async (
      ownerId: string,
      documentIds: string[],
    ): Promise<Record<string, string | null>> => {
      if (documentIds.length === 0) return {};
      const placeholders = documentIds.map(() => "?").join(", ");
      const res = await this.client.execute({
        sql: `SELECT id, request_id FROM documents WHERE owner_id = ? AND id IN (${placeholders})`,
        args: [ownerId, ...documentIds],
      });
      const links: Record<string, string | null> = {};
      for (const row of res.rows) links[String(row.id)] = strOrUndefined(row, "request_id") ?? null;
      return links;
    },
  };

  readonly passages = {
    insert: async (p: PassageInput): Promise<string> => {
      // owner-consistent linking: the parent document must belong to the same owner
      const doc = await this.documents.get(p.ownerId, p.documentId);
      if (!doc) {
        throw new Error(`passage references document ${p.documentId} not owned by ${p.ownerId}`);
      }
      const id = randomUUID();
      // row + FTS mirror land together: the index must never lag the row
      await this.client.batch(
        [
          {
            sql: "INSERT INTO passages (id, owner_id, document_id, heading, excerpt, extraction_status, noise_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [
              id,
              p.ownerId,
              p.documentId,
              p.heading ?? null,
              p.excerpt,
              p.extractionStatus,
              p.noiseClass ?? null,
              now(),
            ],
          },
          {
            sql: "INSERT INTO passages_fts (passage_id, owner_id, excerpt) VALUES (?, ?, ?)",
            args: [id, p.ownerId, p.excerpt],
          },
        ],
        "write",
      );
      return id;
    },
    get: async (ownerId: string, id: string): Promise<PassageRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM passages WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      const row = res.rows[0];
      return row ? passageFromRow(row) : undefined;
    },
    listByDocument: async (ownerId: string, documentId: string): Promise<PassageRow[]> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM passages WHERE owner_id = ? AND document_id = ? ORDER BY created_at",
        args: [ownerId, documentId],
      });
      return res.rows.map(passageFromRow);
    },
  };

  readonly requests = {
    create: async (
      ownerId: string,
      mode: "search" | "answer",
      question: string,
    ): Promise<string> => {
      const id = randomUUID();
      await this.client.execute({
        sql: "INSERT INTO requests (id, owner_id, mode, question, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        args: [id, ownerId, mode, question, now()],
      });
      return id;
    },
    get: async (ownerId: string, id: string): Promise<RequestRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM requests WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      const row = res.rows[0];
      if (!row) return undefined;
      const completedAt = strOrUndefined(row, "completed_at");
      return {
        id: str(row, "id"),
        ownerId: str(row, "owner_id"),
        mode: str(row, "mode"),
        question: str(row, "question"),
        status: str(row, "status"),
        createdAt: str(row, "created_at"),
        completedAt,
      };
    },
    /** ANS-07: completed research (mode search) runs for an owner — the
     * answer service filters these by normalized question for the
     * evidence-basis flag. */
    completedSearches: async (ownerId: string): Promise<RequestRow[]> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM requests WHERE owner_id = ? AND mode = 'search' AND status = 'completed'",
        args: [ownerId],
      });
      return res.rows.map((row) => {
        const completedAt = strOrUndefined(row, "completed_at");
        return {
          id: str(row, "id"),
          ownerId: str(row, "owner_id"),
          mode: str(row, "mode"),
          question: str(row, "question"),
          status: str(row, "status"),
          createdAt: str(row, "created_at"),
          completedAt,
        };
      });
    },
    complete: async (ownerId: string, id: string): Promise<void> => {
      await this.client.execute({
        sql: "UPDATE requests SET status = 'completed', completed_at = ? WHERE id = ? AND owner_id = ?",
        args: [now(), id, ownerId],
      });
    },
    fail: async (ownerId: string, id: string): Promise<void> => {
      await this.client.execute({
        sql: "UPDATE requests SET status = 'failed', completed_at = ? WHERE id = ? AND owner_id = ?",
        args: [now(), id, ownerId],
      });
    },
  };

  readonly answers = {
    insert: async (a: AnswerInput): Promise<string> => {
      // owner-consistent linking: the request must belong to the same owner
      const req = await this.requests.get(a.ownerId, a.requestId);
      if (!req) {
        throw new Error(`answer references request ${a.requestId} not owned by ${a.ownerId}`);
      }
      const id = randomUUID();
      await this.client.execute({
        sql: `INSERT INTO answers (id, owner_id, request_id, blocks_json, evidence_only, cache_key,
               usage_input_tokens, usage_output_tokens, usage_model, usage_estimated,
               prompt_revision, policy_revision, model_revision, evidence_from_run, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          a.ownerId,
          a.requestId,
          JSON.stringify(a.blocks),
          a.evidenceOnly ? 1 : 0,
          a.cacheKey ?? null,
          a.usage?.inputTokens ?? null,
          a.usage?.outputTokens ?? null,
          a.usage?.model ?? null,
          a.usage === undefined ? null : a.usage.estimated ? 1 : 0,
          a.promptRevision ?? "p0",
          a.policyRevision ?? "p0",
          a.modelRevision ?? "m0",
          a.evidenceFromRun ?? null,
          now(),
        ],
      });
      return id;
    },
    get: async (ownerId: string, id: string): Promise<AnswerRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM answers WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      const row = res.rows[0];
      return row ? answerFromRow(row) : undefined;
    },
    /** Exact-answer cache lookup; cache keys are owner-scoped by construction. */
    findByCacheKey: async (ownerId: string, cacheKey: string): Promise<AnswerRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM answers WHERE owner_id = ? AND cache_key = ? ORDER BY created_at DESC LIMIT 1",
        args: [ownerId, cacheKey],
      });
      const row = res.rows[0];
      return row ? answerFromRow(row) : undefined;
    },
  };

  readonly feedback = {
    insert: async (
      ownerId: string,
      answerId: string,
      rating: "up" | "down" | "report",
      comment?: string,
    ): Promise<string> => {
      // owner-consistent linking: the answer must belong to the same owner
      const answer = await this.answers.get(ownerId, answerId);
      if (!answer) {
        throw new Error(`feedback references answer ${answerId} not owned by ${ownerId}`);
      }
      const id = randomUUID();
      await this.client.execute({
        sql: "INSERT INTO feedback (id, owner_id, answer_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, ownerId, answerId, rating, comment ?? null, now()],
      });
      return id;
    },
    listByAnswer: async (ownerId: string, answerId: string): Promise<FeedbackRow[]> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM feedback WHERE owner_id = ? AND answer_id = ? ORDER BY created_at",
        args: [ownerId, answerId],
      });
      return res.rows.map((row) => ({
        id: str(row, "id"),
        rating: str(row, "rating"),
        comment: strOrUndefined(row, "comment"),
        createdAt: str(row, "created_at"),
      }));
    },
  };

  readonly episodes = {
    insert: async (
      ownerId: string,
      question: string,
      outcome: "completed" | "denied" | "failed" | "timeout",
      summary = "",
    ): Promise<string> => {
      const id = randomUUID();
      await this.client.execute({
        sql: "INSERT INTO episodes (id, owner_id, question, summary, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, ownerId, question, summary, outcome, now()],
      });
      return id;
    },
    list: async (ownerId: string, limit = 50): Promise<EpisodeRow[]> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM episodes WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [ownerId, limit],
      });
      return res.rows.map((row) => ({
        id: str(row, "id"),
        question: str(row, "question"),
        summary: str(row, "summary"),
        outcome: str(row, "outcome"),
        createdAt: str(row, "created_at"),
      }));
    },
  };

  readonly jobs = {
    insert: async (
      ownerId: string,
      kind: string,
      payload: Record<string, unknown>,
    ): Promise<string> => {
      const id = randomUUID();
      await this.client.execute({
        sql: "INSERT INTO jobs (id, owner_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
        args: [id, ownerId, kind, JSON.stringify(payload), now(), now()],
      });
      return id;
    },
    get: async (ownerId: string, id: string): Promise<JobRow | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM jobs WHERE id = ? AND owner_id = ?",
        args: [id, ownerId],
      });
      const row = res.rows[0];
      return row ? jobFromRow(row) : undefined;
    },
    setStatus: async (
      ownerId: string,
      id: string,
      status: JobRow["status"],
      extra?: { leaseUntil?: string; lastError?: string },
    ): Promise<void> => {
      await this.client.execute({
        sql: "UPDATE jobs SET status = ?, lease_until = ?, last_error = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
        args: [status, extra?.leaseUntil ?? null, extra?.lastError ?? null, now(), id, ownerId],
      });
    },
  };

  readonly usage = {
    insert: async (u: UsageEntryInput): Promise<string> => {
      const id = randomUUID();
      await this.client.execute({
        sql: `INSERT INTO usage_ledger (id, owner_id, request_id, kind, input_tokens, output_tokens, search_calls, fetches, day, state, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          u.ownerId,
          u.requestId ?? null,
          u.kind,
          u.inputTokens ?? 0,
          u.outputTokens ?? 0,
          u.searchCalls ?? 0,
          u.fetches ?? 0,
          u.day,
          u.state,
          now(),
        ],
      });
      return id;
    },
    /** Sum of reserved/settled token usage for an owner on a UTC day (daily caps). */
    sumTokensForDay: async (
      ownerId: string,
      day: string,
    ): Promise<{ inputTokens: number; outputTokens: number }> => {
      const res = await this.client.execute({
        sql: "SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM usage_ledger WHERE owner_id = ? AND day = ?",
        args: [ownerId, day],
      });
      const row = res.rows[0];
      return { inputTokens: Number(row?.i ?? 0), outputTokens: Number(row?.o ?? 0) };
    },
    setState: async (ownerId: string, id: string, state: UsageEntryRow["state"]): Promise<void> => {
      await this.client.execute({
        sql: "UPDATE usage_ledger SET state = ? WHERE id = ? AND owner_id = ?",
        args: [state, id, ownerId],
      });
    },
  };
}
