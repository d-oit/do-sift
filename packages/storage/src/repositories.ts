/** Repository aggregate. Row shapes and mappers live in rows.ts; this module keeps the query surface. */
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  answerFromRow,
  documentFromRow,
  now,
  passageFromRow,
  str,
  strOrUndefined,
} from "./rows.js";
import { DEFAULT_TENANT, assertTenantId, tenantFilter } from "./tenant.js";
import type {
  AnswerInput,
  AnswerRow,
  DocumentInput,
  DocumentRow,
  EpisodeRow,
  FeedbackRow,
  OwnerRow,
  PassageInput,
  PassageRow,
  RequestRow,
} from "./rows.js";
export type { OwnerRow } from "./rows.js";
export type { DocumentInput } from "./rows.js";
export type { DocumentOrigin } from "./rows.js";
export type { DocumentRow } from "./rows.js";
export type { PassageNoiseClass } from "./rows.js";
export type { PassageInput } from "./rows.js";
export type { PassageRow } from "./rows.js";
export type { AnswerBlocks } from "./rows.js";
export type { AnswerUsage } from "./rows.js";
export type { AnswerInput } from "./rows.js";
export type { AnswerRow } from "./rows.js";
export type { RequestRow } from "./rows.js";
export type { FeedbackRow } from "./rows.js";
export type { EpisodeRow } from "./rows.js";
export type { JobRow } from "./rows.js";
export type { UsageEntryInput } from "./rows.js";
export type { UsageEntryRow } from "./rows.js";

/** Constructor options for the repository aggregate (#120). */
export interface RepositoriesOptions {
  /**
   * Tenant every query is scoped to. Defaults to the `default` tenant, so a
   * single-owner deployment (and all existing callers) keep the exact
   * pre-#120 behaviour.
   */
  tenantId?: string | undefined;
}

export class Repositories {
  /** The tenant this aggregate is bound to; every query filters on it. */
  readonly tenantId: string;

  constructor(
    private readonly client: Client,
    options: RepositoriesOptions = {},
  ) {
    this.tenantId = assertTenantId(options.tenantId ?? DEFAULT_TENANT);
  }

  /** A repository aggregate for another tenant over the same connection (#120). */
  forTenant(tenantId: string): Repositories {
    return new Repositories(this.client, { tenantId });
  }

  /** Raw client for storage-adjacent tooling (e.g. embedding backfill, RET-02). */
  get db(): Client {
    return this.client;
  }

  readonly tenants = {
    ensure: async (id: string, displayName: string): Promise<void> => {
      await this.client.execute({
        sql: "INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [assertTenantId(id), displayName, now()],
      });
    },
    get: async (
      id: string,
    ): Promise<{ id: string; displayName: string; createdAt: string } | undefined> => {
      const res = await this.client.execute({
        sql: "SELECT * FROM tenants WHERE id = ?",
        args: [assertTenantId(id)],
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

  readonly owners = {
    ensure: async (id: string, displayName: string): Promise<void> => {
      await this.client.execute({
        sql: "INSERT INTO owners (id, tenant_id, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [id, this.tenantId, displayName, now()],
      });
    },
    get: async (id: string): Promise<OwnerRow | undefined> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM owners WHERE id = ?${tenantFilter(this.tenantId).sql}`,
        args: [id, this.tenantId],
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
        sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at,
               published_at, published_origin, title, raw_mime, raw_text, request_id, relevance_score, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          this.tenantId,
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
        sql: `SELECT * FROM documents WHERE id = ? AND owner_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [id, ownerId, this.tenantId],
      });
      const row = res.rows[0];
      return row ? documentFromRow(row) : undefined;
    },
    /** SRC-25 cross-run dedup: the owner's most recent document for this
     * URL (canonical or original), undefined when none is stored. */
    findByUrl: async (ownerId: string, url: string): Promise<DocumentRow | undefined> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM documents WHERE owner_id = ? AND (canonical_url = ? OR original_url = ?)${tenantFilter(this.tenantId).sql} ORDER BY created_at DESC LIMIT 1`,
        args: [ownerId, url, url, this.tenantId],
      });
      const row = res.rows[0];
      return row ? documentFromRow(row) : undefined;
    },
    list: async (ownerId: string, limit = 50): Promise<DocumentRow[]> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM documents WHERE owner_id = ?${tenantFilter(this.tenantId).sql} ORDER BY created_at DESC LIMIT ?`,
        args: [ownerId, this.tenantId, limit],
      });
      return res.rows.map(documentFromRow);
    },
    /** ANS-08: document ids linked to the given research request ids. */
    idsByRequestIds: async (ownerId: string, requestIds: string[]): Promise<string[]> => {
      if (requestIds.length === 0) return [];
      const placeholders = requestIds.map(() => "?").join(", ");
      const res = await this.client.execute({
        sql: `SELECT id FROM documents WHERE owner_id = ? AND request_id IN (${placeholders})${tenantFilter(this.tenantId).sql}`,
        args: [ownerId, ...requestIds, this.tenantId],
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
        sql: `SELECT id, request_id FROM documents WHERE owner_id = ? AND id IN (${placeholders})${tenantFilter(this.tenantId).sql}`,
        args: [ownerId, ...documentIds, this.tenantId],
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
            sql: "INSERT INTO passages (id, tenant_id, owner_id, document_id, heading, excerpt, extraction_status, noise_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            args: [
              id,
              this.tenantId,
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
            // FTS mirror has no tenant column by design (migration 0004); the
            // retrieval join re-checks `passages.tenant_id`, so the mirror can
            // never widen a tenant's result set (#120).
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
        sql: `SELECT * FROM passages WHERE id = ? AND owner_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [id, ownerId, this.tenantId],
      });
      const row = res.rows[0];
      return row ? passageFromRow(row) : undefined;
    },
    listByDocument: async (ownerId: string, documentId: string): Promise<PassageRow[]> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM passages WHERE owner_id = ? AND document_id = ?${tenantFilter(this.tenantId).sql} ORDER BY created_at`,
        args: [ownerId, documentId, this.tenantId],
      });
      return res.rows.map(passageFromRow);
    },
    /** SRC-25 cross-run dedup: how many passages the owner has for a document. */
    countByDocument: async (ownerId: string, documentId: string): Promise<number> => {
      const res = await this.client.execute({
        sql: `SELECT COUNT(*) AS n FROM passages WHERE owner_id = ? AND document_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [ownerId, documentId, this.tenantId],
      });
      const row = res.rows[0];
      return row ? Number(row.n) : 0;
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
        sql: "INSERT INTO requests (id, tenant_id, owner_id, mode, question, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        args: [id, this.tenantId, ownerId, mode, question, now()],
      });
      return id;
    },
    get: async (ownerId: string, id: string): Promise<RequestRow | undefined> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM requests WHERE id = ? AND owner_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [id, ownerId, this.tenantId],
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
        sql: `SELECT * FROM requests WHERE owner_id = ? AND mode = 'search' AND status = 'completed'${tenantFilter(this.tenantId).sql}`,
        args: [ownerId, this.tenantId],
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
        sql: `UPDATE requests SET status = 'completed', completed_at = ? WHERE id = ? AND owner_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [now(), id, ownerId, this.tenantId],
      });
    },
    fail: async (ownerId: string, id: string): Promise<void> => {
      await this.client.execute({
        sql: `UPDATE requests SET status = 'failed', completed_at = ? WHERE id = ? AND owner_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [now(), id, ownerId, this.tenantId],
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
        sql: `INSERT INTO answers (id, tenant_id, owner_id, request_id, blocks_json, evidence_only, cache_key,
               usage_input_tokens, usage_output_tokens, usage_model, usage_estimated,
               prompt_revision, policy_revision, model_revision, evidence_from_run, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          this.tenantId,
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
        sql: `SELECT * FROM answers WHERE id = ? AND owner_id = ?${tenantFilter(this.tenantId).sql}`,
        args: [id, ownerId, this.tenantId],
      });
      const row = res.rows[0];
      return row ? answerFromRow(row) : undefined;
    },
    /** Exact-answer cache lookup; cache keys are owner- and tenant-scoped by construction. */
    findByCacheKey: async (ownerId: string, cacheKey: string): Promise<AnswerRow | undefined> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM answers WHERE owner_id = ? AND cache_key = ?${tenantFilter(this.tenantId).sql} ORDER BY created_at DESC LIMIT 1`,
        args: [ownerId, cacheKey, this.tenantId],
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
        sql: "INSERT INTO feedback (id, tenant_id, owner_id, answer_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [id, this.tenantId, ownerId, answerId, rating, comment ?? null, now()],
      });
      return id;
    },
    listByAnswer: async (ownerId: string, answerId: string): Promise<FeedbackRow[]> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM feedback WHERE owner_id = ? AND answer_id = ?${tenantFilter(this.tenantId).sql} ORDER BY created_at`,
        args: [ownerId, answerId, this.tenantId],
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
        sql: "INSERT INTO episodes (id, tenant_id, owner_id, question, summary, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [id, this.tenantId, ownerId, question, summary, outcome, now()],
      });
      return id;
    },
    list: async (ownerId: string, limit = 50): Promise<EpisodeRow[]> => {
      const res = await this.client.execute({
        sql: `SELECT * FROM episodes WHERE owner_id = ?${tenantFilter(this.tenantId).sql} ORDER BY created_at DESC LIMIT ?`,
        args: [ownerId, this.tenantId, limit],
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
}
