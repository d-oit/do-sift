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

export class VectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorValidationError";
  }
}

export class VectorCountMismatchError extends VectorValidationError {
  constructor(expected: number, actual: number) {
    super(`expected ${expected} vectors for input passages, got ${actual}`);
    this.name = "VectorCountMismatchError";
  }
}

export class VectorDimensionMismatchError extends VectorValidationError {
  constructor(expected: number, actual: number) {
    super(`expected vector dimension ${expected}, got ${actual}`);
    this.name = "VectorDimensionMismatchError";
  }
}

export class NonFiniteVectorError extends VectorValidationError {
  constructor(index?: number, value?: number) {
    const detail = index !== undefined ? ` at index ${index} (value: ${value})` : "";
    super(`vector contains non-finite float value${detail}`);
    this.name = "NonFiniteVectorError";
  }
}

export class EmptyVectorError extends VectorValidationError {
  constructor() {
    super("vector is empty or has zero dimension");
    this.name = "EmptyVectorError";
  }
}

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
  /**
   * The tenant the caller believes it is serving (plan 035). The write still
   * copies `tenant_id` from the authoritative owners row; when supplied the
   * two must agree or the write is refused.
   */
  tenantId?: string | undefined;
}

export interface BackfillOptions {
  /** Batch size per embed + persist operation. Default: 50. Range: [1, 500]. */
  batchSize?: number | undefined;
  /** Signal for cancellation / deadline. */
  signal?: AbortSignal | undefined;
  /** Caller's tenant scope (plan 035); must agree with the owners row. */
  tenantId?: string | undefined;
}

export interface BackfillResult {
  modelId: string;
  batchCount: number;
  passagesCompleted: number;
  passagesSkipped: number;
  durationMs: number;
  failureClass?: string | undefined;
}

export function validateVector(vector: number[], expectedDimension?: number): number[] {
  if (!Array.isArray(vector)) {
    throw new VectorValidationError("vector must be an array of numbers");
  }
  if (vector.length === 0) {
    throw new EmptyVectorError();
  }
  if (expectedDimension !== undefined && vector.length !== expectedDimension) {
    throw new VectorDimensionMismatchError(expectedDimension, vector.length);
  }
  for (let i = 0; i < vector.length; i++) {
    const val = vector[i];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new NonFiniteVectorError(i, val);
    }
  }
  return vector;
}

export function vectorToBlob(vector: number[]): Uint8Array {
  validateVector(vector);
  return new Uint8Array(new Float32Array(vector).buffer);
}

export function blobToVector(blob: unknown, expectedDimension?: number): number[] {
  if (!(blob instanceof Uint8Array) && !(blob instanceof ArrayBuffer)) {
    throw new TypeError(`expected embedding BLOB, got ${typeof blob}`);
  }
  let floatArray: Float32Array;
  // Honour the view window: a sliced Uint8Array shares a larger ArrayBuffer.
  if (blob instanceof Uint8Array) {
    if (blob.byteLength % 4 !== 0) {
      throw new RangeError(`embedding BLOB length ${blob.byteLength} is not a multiple of 4`);
    }
    floatArray = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  } else {
    if (blob.byteLength % 4 !== 0) {
      throw new RangeError(`embedding BLOB length ${blob.byteLength} is not a multiple of 4`);
    }
    floatArray = new Float32Array(blob);
  }
  const vec = Array.from(floatArray);
  if (vec.length === 0) {
    throw new EmptyVectorError();
  }
  if (expectedDimension !== undefined && vec.length !== expectedDimension) {
    throw new VectorDimensionMismatchError(expectedDimension, vec.length);
  }
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) {
      throw new NonFiniteVectorError(i, vec[i]);
    }
  }
  return vec;
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

/**
 * Vector width recorded for this model, sampled from the caller's own rows
 * (plan 035). Scoping the sample to `ownerId` keeps one tenant's model run
 * from being silently coupled to another tenant's vector width; passing
 * `tenantId` additionally requires the row to agree with the caller's tenant.
 */
export async function getExistingModelDimension(
  client: Client,
  modelId: string,
  ownerId: string,
  tenantId?: string,
): Promise<number | undefined> {
  const scoped = tenantId !== undefined;
  const existing = await client.execute({
    sql: `SELECT vector FROM passage_embeddings
          WHERE model_id = ? AND owner_id = ?
            AND tenant_id = (SELECT tenant_id FROM owners WHERE id = ?)
            ${scoped ? "AND tenant_id = ?" : ""}
          LIMIT 1`,
    args: [modelId, ownerId, ownerId, ...(scoped ? [tenantId] : [])],
  });
  if (existing.rows.length === 0 || !existing.rows[0]?.vector) {
    return undefined;
  }
  try {
    const vec = blobToVector(existing.rows[0].vector);
    return vec.length;
  } catch {
    return undefined;
  }
}

/** Store (or replace) embeddings for known passage ids, in one batch inside a write transaction. */
export async function storePassageEmbeddings(
  client: Client,
  modelId: string,
  rows: EmbeddingRowInput[],
): Promise<void> {
  if (!modelId || typeof modelId !== "string" || modelId.trim() === "") {
    throw new VectorValidationError("modelId must be a non-empty string");
  }
  if (rows.length === 0) return;

  // Plan 035: widths are learned from the rows this caller owns, never from
  // an arbitrary row of the table.
  const first = rows[0]!;
  const scope = first.tenantId;
  if (scope !== undefined) {
    for (const row of rows) {
      if (row.tenantId !== scope) {
        throw new VectorValidationError("a batch may not mix tenant scopes");
      }
      if (row.ownerId !== first.ownerId) {
        throw new VectorValidationError("a batch may not mix owner ids");
      }
    }
  }

  let expectedDimension = await getExistingModelDimension(client, modelId, first.ownerId, scope);
  if (expectedDimension === undefined && first.vector) {
    expectedDimension = first.vector.length;
  }

  for (const row of rows) {
    validateVector(row.vector, expectedDimension);
  }

  if (scope !== undefined) {
    const owner = await client.execute({
      sql: "SELECT tenant_id FROM owners WHERE id = ? AND tenant_id = ?",
      args: [first.ownerId, scope],
    });
    if (owner.rows.length === 0) {
      throw new VectorValidationError(
        `tenant scope ${scope} does not own ${first.ownerId}; refusing to store embeddings`,
      );
    }
  }

  const now = new Date().toISOString();
  const tx = await client.transaction("write");
  try {
    for (const row of rows) {
      // Plan 024: the tenant is copied from the authoritative owner row, so
      // an embedding can never be filed under a tenant its passage's owner
      // does not belong to. Plan 035: an explicit scope was checked above and
      // is used as the stored value, so the two can never disagree.
      const tenantSql =
        scope === undefined
          ? "(SELECT tenant_id FROM owners WHERE id = ?)"
          : "(SELECT tenant_id FROM owners WHERE id = ? AND tenant_id = ?)";
      await tx.execute({
        sql: `INSERT OR REPLACE INTO passage_embeddings (passage_id, tenant_id, owner_id, model_id, vector, created_at)
              VALUES (?, ${tenantSql}, ?, ?, ?, ?)`,
        args: [
          row.passageId,
          row.ownerId,
          ...(scope === undefined ? [] : [scope]),
          row.ownerId,
          modelId,
          vectorToBlob(row.vector),
          now,
        ],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/**
 * Embed passages of the owner that have no embedding for this model yet
 * (backfill after research runs) using bounded keyset pagination.
 * Processes batchSize passages at a time, validating vectors and writing
 * each batch within its own transaction.
 */
export async function backfillPassageEmbeddings(
  client: Client,
  ownerId: string,
  embedder: TextEmbedder,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError("batchSize must be an integer between 1 and 500");
  }

  const signal = options.signal;
  const scope = options.tenantId;
  const startTime = Date.now();
  let lastPassageId = "";
  let batchCount = 0;
  let passagesCompleted = 0;
  let passagesSkipped = 0;
  let failureClass: string | undefined;

  let expectedDimension = await getExistingModelDimension(client, embedder.modelId, ownerId, scope);

  while (true) {
    if (signal?.aborted) {
      failureClass =
        failureClass ?? (signal.reason instanceof Error ? signal.reason.name : "AbortError");
      break;
    }

    const pending = await client.execute({
      sql: `SELECT p.id, p.excerpt FROM passages p
            LEFT JOIN passage_embeddings pe ON pe.passage_id = p.id AND pe.model_id = ?
            WHERE p.owner_id = ?
              AND p.tenant_id = (SELECT tenant_id FROM owners WHERE id = ?)
              ${scope === undefined ? "" : "AND p.tenant_id = ?"}
              AND pe.passage_id IS NULL AND p.id > ?
            ORDER BY p.id ASC
            LIMIT ?`,
      args: [
        embedder.modelId,
        ownerId,
        ownerId,
        ...(scope === undefined ? [] : [scope]),
        lastPassageId,
        batchSize,
      ],
    });

    if (pending.rows.length === 0) {
      break;
    }

    batchCount++;
    const batchPassages = pending.rows.map((r) => ({
      id: String(r.id),
      excerpt: String(r.excerpt),
    }));

    lastPassageId = batchPassages[batchPassages.length - 1]!.id;

    if (signal?.aborted) {
      failureClass =
        failureClass ?? (signal.reason instanceof Error ? signal.reason.name : "AbortError");
      break;
    }

    try {
      const texts = batchPassages.map((p) => p.excerpt);
      const vectors = await embedder.embedPassages(texts);

      if (vectors.length !== texts.length) {
        throw new VectorCountMismatchError(texts.length, vectors.length);
      }

      if (expectedDimension === undefined && vectors.length > 0 && vectors[0]?.length) {
        expectedDimension = vectors[0].length;
      }

      const rows: EmbeddingRowInput[] = batchPassages.map((p, i) => {
        const vector = vectors[i];
        if (!vector) {
          throw new VectorValidationError("missing vector for passage");
        }
        const row: EmbeddingRowInput = { passageId: p.id, ownerId, vector };
        if (scope !== undefined) row.tenantId = scope;
        return row;
      });

      await storePassageEmbeddings(client, embedder.modelId, rows);
      passagesCompleted += rows.length;
    } catch (err: unknown) {
      const className = err instanceof Error ? err.name || err.constructor.name : "UnknownError";
      failureClass = failureClass ?? className;
      passagesSkipped += batchPassages.length;
      break;
    }
  }

  return {
    modelId: embedder.modelId,
    batchCount,
    passagesCompleted,
    passagesSkipped,
    durationMs: Date.now() - startTime,
    ...(failureClass ? { failureClass } : {}),
  };
}

function vectorHitFromRow(
  row: Row,
  queryVector: number[],
): { hit: VectorHit; score: number } | null {
  try {
    const vector = blobToVector(row.vector, queryVector.length);
    const score = cosineSimilarity(queryVector, vector);
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
  } catch {
    return null;
  }
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
 * exclusion is read-time and never storage-time. `noiseFilter` (SRC-12)
 * drops passages flagged at store time with a noise class — NULL
 * (unclassified/legacy) is ALWAYS included, byte-identical when omitted.
 */
/**
 * Upper bound on candidate rows decoded per search (#56). Newest first, so an
 * owner past the cap loses only its oldest embeddings from recall; the cap is
 * applied in SQL, before any BLOB is decoded.
 */
export const MAX_EMBEDDING_CANDIDATES = 5000;

export async function searchByEmbedding(
  client: Client,
  ownerId: string,
  modelId: string,
  queryVector: number[],
  limit = 10,
  documentIds?: string[],
  relevanceFloor?: number,
  noiseFilter?: boolean,
  tenantId?: string,
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
  const noiseClause = noiseFilter === true ? " AND p.noise_class IS NULL" : "";
  const tenantClause = tenantId === undefined ? "" : " AND pe.tenant_id = ?";
  const res = await client.execute({
    sql: `SELECT pe.passage_id, p.document_id, d.content_hash, p.excerpt, pe.vector
          FROM passage_embeddings pe
          JOIN passages p ON p.id = pe.passage_id AND p.owner_id = ?
          JOIN documents d ON d.id = p.document_id AND d.owner_id = p.owner_id
          WHERE pe.owner_id = ? AND pe.model_id = ?
            AND pe.tenant_id = (SELECT tenant_id FROM owners WHERE id = ?)
            AND p.tenant_id = pe.tenant_id AND d.tenant_id = p.tenant_id${tenantClause}${docFilter}${floorFilter}${noiseClause}
          ORDER BY pe.created_at DESC
          LIMIT ?`,
    args: [
      ownerId,
      ownerId,
      modelId,
      // Plan 024: tenant derived from the authoritative owner row.
      ownerId,
      // Plan 035: an explicit scope must agree with that derivation.
      ...(tenantId === undefined ? [] : [tenantId]),
      ...(documentIds && documentIds.length > 0 ? documentIds : []),
      ...(relevanceFloor === undefined ? [] : [relevanceFloor]),
      MAX_EMBEDDING_CANDIDATES,
    ],
  });
  return res.rows
    .map((row: Row) => vectorHitFromRow(row, queryVector))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
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
 * exclusion through BOTH halves of the fusion; `noiseFilter` (SRC-12)
 * threads the noise-class exclusion the same way.
 */
export async function hybridSearch(
  client: Client,
  ownerId: string,
  question: string,
  limit = 10,
  embedder: TextEmbedder,
  documentIds?: string[],
  relevanceFloor?: number,
  noiseFilter?: boolean,
  tenantId?: string,
): Promise<PassageHit[]> {
  const bm25 = await searchPassages(
    client,
    ownerId,
    question,
    limit,
    documentIds,
    relevanceFloor,
    noiseFilter,
    tenantId,
  );
  const queryVector = await embedder.embedQuery(question);
  const vector = await searchByEmbedding(
    client,
    ownerId,
    embedder.modelId,
    queryVector,
    limit,
    documentIds,
    relevanceFloor,
    noiseFilter,
    tenantId,
  );
  return rrfFuse(bm25, vector, limit);
}
