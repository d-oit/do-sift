/**
 * Embedding storage + hybrid retrieval (RET-02, ADR 0009). Vectors are
 * Float32 bytes per (passage, model), owner-scoped like every table. Fusion
 * is reciprocal-rank fusion over the bm25 baseline (SRC-04) and cosine
 * ranks; the bm25 path stays the fallback whenever no embedder is provided.
 * Brute-force cosine at dev scale — the pinned client has no native vector
 * functions (plans/011 spike); a Turso-side index is an activation-gate
 * question (plans/sources.md).
 *
 * The embedder itself is injected (TextEmbedder) so storage stays free of
 * the ONNX runtime; the fastembed-backed implementation lives in
 * fastembed-embedder.ts.
 */
import type { Client, Row } from "@libsql/client";
import { searchPassages, type PassageHit } from "./retrieval.js";

export interface TextEmbedder {
  readonly modelId: string;
  /** Embed passage/body texts (no query prefix). */
  embedPassages(texts: string[]): Promise<number[][]>;
  /** Embed one query (implementations may apply a model-specific prefix). */
  embedQuery(text: string): Promise<number[]>;
}

export interface EmbeddingRowInput {
  passageId: string;
  ownerId: string;
  vector: number[];
}

export function vectorToBlob(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

export function blobToVector(blob: unknown): number[] {
  if (!(blob instanceof Uint8Array) && !(blob instanceof ArrayBuffer)) {
    throw new TypeError(`expected embedding BLOB, got ${typeof blob}`);
  }
  return Array.from(new Float32Array(blob instanceof Uint8Array ? blob.buffer : blob));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Store (or replace) embeddings for known passage ids, in one batch. */
export async function storePassageEmbeddings(
  client: Client,
  modelId: string,
  rows: EmbeddingRowInput[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const row of rows) {
    await client.execute({
      sql: `INSERT OR REPLACE INTO passage_embeddings (passage_id, owner_id, model_id, vector, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [row.passageId, row.ownerId, modelId, vectorToBlob(row.vector), now],
    });
  }
}

/**
 * Embed every passage of the owner that has no embedding for this model yet
 * (backfill after research runs). Returns how many passages were embedded.
 */
export async function backfillPassageEmbeddings(
  client: Client,
  ownerId: string,
  embedder: TextEmbedder,
): Promise<number> {
  const pending = await client.execute({
    sql: `SELECT p.id, p.excerpt FROM passages p
          LEFT JOIN passage_embeddings pe ON pe.passage_id = p.id AND pe.model_id = ?
          WHERE p.owner_id = ? AND pe.passage_id IS NULL`,
    args: [embedder.modelId, ownerId],
  });
  if (pending.rows.length === 0) return 0;
  const texts = pending.rows.map((r) => String(r.excerpt));
  const vectors = await embedder.embedPassages(texts);
  const rows: EmbeddingRowInput[] = pending.rows.map((r, i) => ({
    passageId: String(r.id),
    ownerId,
    vector: vectors[i] ?? [],
  }));
  await storePassageEmbeddings(client, embedder.modelId, rows);
  return rows.length;
}

function vectorHitFromRow(row: Row, queryVector: number[]): { hit: VectorHit; score: number } {
  const score = cosineSimilarity(queryVector, blobToVector(row.vector));
  return {
    score,
    hit: {
      passageId: String(row.passage_id),
      documentId: String(row.document_id),
      contentHash: String(row.content_hash),
      excerpt: String(row.excerpt),
      score,
    },
  };
}

export interface VectorHit {
  passageId: string;
  documentId: string;
  contentHash: string;
  excerpt: string;
  /** Cosine similarity (higher is better). */
  score: number;
}

/**
 * Owner-scoped cosine search over stored embeddings. Candidates come from
 * SQL (owner + model filtered, joined for provenance); similarity and
 * ordering are computed in JS — brute force is honest at dev scale.
 * `relevanceFloor` (SRC-11, answer-time exclusion) optionally filters
 * candidates scored below the designed floor — advisory: documents with
 * NO relevance score (NULL = legacy/unmeasured) are ALWAYS included;
 * exclusion is read-time and never storage-time.
 */
export async function searchByEmbedding(
  client: Client,
  ownerId: string,
  modelId: string,
  queryVector: number[],
  limit = 10,
  documentIds?: string[],
  relevanceFloor?: number,
): Promise<VectorHit[]> {
  if (queryVector.length === 0) return [];
  const docFilter =
    documentIds && documentIds.length > 0
      ? ` AND p.document_id IN (${documentIds.map(() => "?").join(", ")})`
      : "";
  const floorFilter =
    relevanceFloor === undefined
      ? ""
      : " AND (d.relevance_score IS NULL OR d.relevance_score >= ?)";
  const res = await client.execute({
    sql: `SELECT pe.passage_id, p.document_id, d.content_hash, p.excerpt, pe.vector
          FROM passage_embeddings pe
          JOIN passages p ON p.id = pe.passage_id AND p.owner_id = ?
          JOIN documents d ON d.id = p.document_id
          WHERE pe.owner_id = ? AND pe.model_id = ?${docFilter}${floorFilter}`,
    args: [
      ownerId,
      ownerId,
      modelId,
      ...(documentIds && documentIds.length > 0 ? documentIds : []),
      ...(relevanceFloor === undefined ? [] : [relevanceFloor]),
    ],
  });
  return res.rows
    .map((row: Row) => vectorHitFromRow(row, queryVector))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.hit);
}

const RRF_K = 60;

/**
 * Reciprocal-rank fusion of the bm25 list and the vector list. Output keeps
 * PassageHit's shape (provenance from whichever list saw the passage); the
 * `score` field holds the fused RRF score (higher is better) for fused hits.
 */
export function rrfFuse(bm25: PassageHit[], vector: VectorHit[], limit: number): PassageHit[] {
  const byId = new Map<string, { hit: PassageHit; score: number }>();
  bm25.forEach((hit, index) => {
    const contribution = 1 / (RRF_K + index + 1);
    const existing = byId.get(hit.passageId);
    if (existing) existing.score += contribution;
    else byId.set(hit.passageId, { hit, score: contribution });
  });
  vector.forEach((hit, index) => {
    const contribution = 1 / (RRF_K + index + 1);
    const existing = byId.get(hit.passageId);
    if (existing) existing.score += contribution;
    else
      byId.set(hit.passageId, {
        hit: {
          passageId: hit.passageId,
          documentId: hit.documentId,
          contentHash: hit.contentHash,
          excerpt: hit.excerpt,
          score: contribution,
        },
        score: contribution,
      });
  });
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.hit, score: entry.score }));
}

/**
 * Hybrid retrieval (RET-02): bm25 baseline ranks fused with cosine ranks
 * over stored embeddings. Tokenless or keyword-free questions still retrieve
 * through the vector list; passages without an embedding only surface via
 * the bm25 side. `relevanceFloor` (SRC-11) threads the answer-time
 * exclusion through BOTH halves of the fusion.
 */
export async function hybridSearch(
  client: Client,
  ownerId: string,
  question: string,
  limit = 10,
  embedder: TextEmbedder,
  documentIds?: string[],
  relevanceFloor?: number,
): Promise<PassageHit[]> {
  const bm25 = await searchPassages(client, ownerId, question, limit, documentIds, relevanceFloor);
  const queryVector = await embedder.embedQuery(question);
  const vector = await searchByEmbedding(
    client,
    ownerId,
    embedder.modelId,
    queryVector,
    limit,
    documentIds,
    relevanceFloor,
  );
  return rrfFuse(bm25, vector, limit);
}
