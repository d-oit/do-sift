/**
 * Research workspaces: collections, item references, and owner notes
 * (issue #168, migration 0014).
 *
 * This repository is bound to exactly one `(tenantId, ownerId)` pair, so every
 * statement filters on both. Collections only **reference** existing runs and
 * evidence ids; no evidence row is copied, rewritten, or deleted through this
 * surface. Notes are author-authored metadata and are never treated as source
 * evidence.
 *
 * The database triggers in 0014 also enforce that an item or note belongs to a
 * collection in the same scope; this layer fails closed before that happens.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { DEFAULT_TENANT_ID } from "@do-sift/contracts";

export type CollectionItemKind = "run" | "evidence";

export interface CollectionRow {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | undefined;
}

export interface CollectionItemRow {
  collectionId: string;
  itemKind: CollectionItemKind;
  itemId: string;
  addedAt: string;
  /** Provenance snapshot taken at attach time (evidence items only). */
  evidenceUrl?: string | undefined;
  evidenceTitle?: string | undefined;
  evidenceFetchedAt?: string | undefined;
}

export interface CollectionNoteRow {
  id: string;
  collectionId: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export const COLLECTION_TITLE_MAX = 200;
export const COLLECTION_DESCRIPTION_MAX = 2000;
export const COLLECTION_NOTE_MAX = 8000;
export const COLLECTION_LIST_DEFAULT = 50;
export const COLLECTION_LIST_MAX = 100;

function isoNow(): string {
  return new Date().toISOString();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function strOrUndefined(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function collectionFromRow(row: Record<string, unknown>): CollectionRow {
  const archivedAt = strOrUndefined(row["archived_at"]);
  return {
    id: str(row["id"]),
    title: str(row["title"]),
    description: str(row["description"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}

export class CollectionsRepository {
  readonly tenantId: string;
  readonly ownerId: string;

  constructor(
    private readonly client: Client,
    ownerId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ) {
    if (ownerId.trim() === "") throw new Error("CollectionsRepository needs a non-empty owner id");
    if (tenantId.trim() === "")
      throw new Error("CollectionsRepository needs a non-empty tenant id");
    this.ownerId = ownerId;
    this.tenantId = tenantId;
  }

  private assertTitle(title: string): void {
    if (title.trim() === "") throw new Error("collection title must not be empty");
    if (title.length > COLLECTION_TITLE_MAX) {
      throw new Error(`collection title must be at most ${COLLECTION_TITLE_MAX} characters`);
    }
  }

  private assertDescription(description: string): void {
    if (description.length > COLLECTION_DESCRIPTION_MAX) {
      throw new Error(
        `collection description must be at most ${COLLECTION_DESCRIPTION_MAX} characters`,
      );
    }
  }

  async create(title: string, description = ""): Promise<CollectionRow> {
    this.assertTitle(title);
    this.assertDescription(description);
    const at = isoNow();
    const id = randomUUID();
    await this.client.execute({
      sql: "INSERT INTO collections (id, tenant_id, owner_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [id, this.tenantId, this.ownerId, title, description, at, at],
    });
    return {
      id,
      title,
      description,
      createdAt: at,
      updatedAt: at,
    };
  }

  async list(
    options: { limit?: number; includeArchived?: boolean } = {},
  ): Promise<CollectionRow[]> {
    const limit = options.limit ?? COLLECTION_LIST_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_LIST_MAX) {
      throw new Error(`limit must be an integer from 1 to ${COLLECTION_LIST_MAX}`);
    }
    const archivedClause = options.includeArchived === true ? "" : " AND archived_at IS NULL";
    const res = await this.client.execute({
      sql: `SELECT id, title, description, created_at, updated_at, archived_at
            FROM collections
            WHERE tenant_id = ? AND owner_id = ?${archivedClause}
            ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [this.tenantId, this.ownerId, limit],
    });
    return res.rows.map((row) => collectionFromRow(row as unknown as Record<string, unknown>));
  }

  async get(id: string): Promise<CollectionRow | undefined> {
    const res = await this.client.execute({
      sql: "SELECT id, title, description, created_at, updated_at, archived_at FROM collections WHERE id = ? AND tenant_id = ? AND owner_id = ?",
      args: [id, this.tenantId, this.ownerId],
    });
    const row = res.rows[0];
    return row === undefined
      ? undefined
      : collectionFromRow(row as unknown as Record<string, unknown>);
  }

  async update(id: string, changes: { title?: string; description?: string }): Promise<boolean> {
    const sets: string[] = [];
    const args: string[] = [];
    if (changes.title !== undefined) {
      this.assertTitle(changes.title);
      sets.push("title = ?");
      args.push(changes.title);
    }
    if (changes.description !== undefined) {
      this.assertDescription(changes.description);
      sets.push("description = ?");
      args.push(changes.description);
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    args.push(isoNow());
    const res = await this.client.execute({
      sql: `UPDATE collections SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ? AND owner_id = ?`,
      args: [...args, id, this.tenantId, this.ownerId],
    });
    return res.rowsAffected > 0;
  }

  async archive(id: string): Promise<boolean> {
    const at = isoNow();
    const res = await this.client.execute({
      sql: "UPDATE collections SET archived_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_id = ? AND archived_at IS NULL",
      args: [at, at, id, this.tenantId, this.ownerId],
    });
    return res.rowsAffected > 0;
  }

  /**
   * Add a reference to an existing run or evidence id; never copies a row.
   * For evidence that resolves in this scope, the provenance needed by a
   * report (url/title/fetched_at) is snapshotted alongside the reference.
   * Unresolvable ids are still accepted as references, with null metadata.
   */
  async addItem(collectionId: string, kind: CollectionItemKind, itemId: string): Promise<void> {
    if (itemId.trim() === "") throw new Error("item id must not be empty");
    const collection = await this.get(collectionId);
    if (collection === undefined) throw new Error("collection not found in this scope");
    if (collection.archivedAt !== undefined) throw new Error("collection is archived");
    const metadata = kind === "evidence" ? await this.evidenceMetadata(itemId) : undefined;
    await this.client.execute({
      sql: `INSERT INTO collection_items
              (collection_id, tenant_id, owner_id, item_kind, item_id, added_at,
               evidence_url, evidence_title, evidence_fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(collection_id, item_kind, item_id) DO NOTHING`,
      args: [
        collectionId,
        this.tenantId,
        this.ownerId,
        kind,
        itemId,
        isoNow(),
        metadata?.url ?? null,
        metadata?.title ?? null,
        metadata?.fetchedAt ?? null,
      ],
    });
  }

  private async evidenceMetadata(
    itemId: string,
  ): Promise<{ url: string; title?: string | undefined; fetchedAt: string } | undefined> {
    const res = await this.client.execute({
      sql: `SELECT d.canonical_url, d.title, d.fetched_at
            FROM passages p
            JOIN documents d
              ON d.id = p.document_id
             AND d.owner_id = p.owner_id
             AND d.tenant_id = p.tenant_id
            WHERE p.tenant_id = ? AND p.owner_id = ?
              AND (p.id = ? OR p.document_id = ?)
            ORDER BY p.document_id, p.created_at, p.id LIMIT 1`,
      args: [this.tenantId, this.ownerId, itemId, itemId],
    });
    const row = res.rows[0];
    if (row === undefined) return undefined;
    const title = strOrUndefined(row["title"]);
    return {
      url: str(row["canonical_url"]),
      ...(title === undefined ? {} : { title }),
      fetchedAt: str(row["fetched_at"]),
    };
  }

  async removeItem(
    collectionId: string,
    kind: CollectionItemKind,
    itemId: string,
  ): Promise<boolean> {
    const res = await this.client.execute({
      sql: "DELETE FROM collection_items WHERE collection_id = ? AND tenant_id = ? AND owner_id = ? AND item_kind = ? AND item_id = ?",
      args: [collectionId, this.tenantId, this.ownerId, kind, itemId],
    });
    return res.rowsAffected > 0;
  }

  async items(collectionId: string, limit = COLLECTION_LIST_MAX): Promise<CollectionItemRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_LIST_MAX) {
      throw new Error(`limit must be an integer from 1 to ${COLLECTION_LIST_MAX}`);
    }
    const res = await this.client.execute({
      sql: `SELECT collection_id, item_kind, item_id, added_at,
                   evidence_url, evidence_title, evidence_fetched_at
            FROM collection_items
            WHERE collection_id = ? AND tenant_id = ? AND owner_id = ?
            ORDER BY added_at, item_kind, item_id LIMIT ?`,
      args: [collectionId, this.tenantId, this.ownerId, limit],
    });
    return res.rows.map((row) => {
      const evidenceUrl = strOrUndefined(row["evidence_url"]);
      const evidenceTitle = strOrUndefined(row["evidence_title"]);
      const evidenceFetchedAt = strOrUndefined(row["evidence_fetched_at"]);
      return {
        collectionId: str(row["collection_id"]),
        itemKind: str(row["item_kind"]) as CollectionItemKind,
        itemId: str(row["item_id"]),
        addedAt: str(row["added_at"]),
        ...(evidenceUrl === undefined ? {} : { evidenceUrl }),
        ...(evidenceTitle === undefined ? {} : { evidenceTitle }),
        ...(evidenceFetchedAt === undefined ? {} : { evidenceFetchedAt }),
      };
    });
  }

  /** Owner-authored note; `authorId` may name a member, never an evidence row. */
  async addNote(
    collectionId: string,
    body: string,
    authorId = this.ownerId,
  ): Promise<CollectionNoteRow> {
    if (body.trim() === "") throw new Error("note body must not be empty");
    if (body.length > COLLECTION_NOTE_MAX) {
      throw new Error(`note body must be at most ${COLLECTION_NOTE_MAX} characters`);
    }
    if (authorId.trim() === "") throw new Error("note author must not be empty");
    const collection = await this.get(collectionId);
    if (collection === undefined) throw new Error("collection not found in this scope");
    const at = isoNow();
    const row: CollectionNoteRow = {
      id: randomUUID(),
      collectionId,
      body,
      authorId,
      createdAt: at,
      updatedAt: at,
    };
    await this.client.execute({
      sql: `INSERT INTO collection_notes (id, collection_id, tenant_id, owner_id, author_id, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [row.id, collectionId, this.tenantId, this.ownerId, authorId, body, at, at],
    });
    return row;
  }

  async notes(collectionId: string): Promise<CollectionNoteRow[]> {
    const res = await this.client.execute({
      sql: `SELECT id, collection_id, body, author_id, created_at, updated_at
            FROM collection_notes
            WHERE collection_id = ? AND tenant_id = ? AND owner_id = ?
            ORDER BY created_at, id`,
      args: [collectionId, this.tenantId, this.ownerId],
    });
    return res.rows.map((row) => ({
      id: str(row["id"]),
      collectionId: str(row["collection_id"]),
      body: str(row["body"]),
      authorId: str(row["author_id"]),
      createdAt: str(row["created_at"]),
      updatedAt: str(row["updated_at"]),
    }));
  }

  async deleteNote(noteId: string): Promise<boolean> {
    const res = await this.client.execute({
      sql: "DELETE FROM collection_notes WHERE id = ? AND tenant_id = ? AND owner_id = ?",
      args: [noteId, this.tenantId, this.ownerId],
    });
    return res.rowsAffected > 0;
  }
}
