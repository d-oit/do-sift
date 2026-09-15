/**
 * FTS5 retrieval baseline (SRC-04, ADR 0002). Keyword retrieval over the
 * passages_fts index, bm25-ranked, owner-scoped on every query. This is the
 * baseline the RET milestone must beat with vectors before any embedding
 * work lands (plan 007); it is deliberately the ONLY ranking path until
 * then.
 *
 * Query safety: user input is tokenized to plain words and re-quoted, so
 * FTS5 MATCH operators (OR/NEAR/colons/asterisks/quotes) in a question can
 * never widen the search or crash the query.
 */
import type { Client, Row } from "@libsql/client";

export interface PassageHit {
  passageId: string;
  documentId: string;
  /** The source document's content hash — the cache key's source-version input. */
  contentHash: string;
  excerpt: string;
  /** bm25 score (lower is better; exposed for debugging/evals). */
  score: number;
}

/** Tiny stopword set — OR/AND etc. are noise in an OR-of-tokens query. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

/** Plain-word tokens, length ≥ 2, capped — nothing that could be MATCH syntax. */
export function extractQueryTokens(text: string): string[] {
  const tokens = (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/gu) ?? []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t),
  );
  return [...new Set(tokens)].slice(0, 24);
}

/** Build a quoted OR-of-tokens MATCH expression, or null for no tokens. */
export function buildMatchQuery(text: string): string | null {
  const tokens = extractQueryTokens(text);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function hitFromRow(row: Row): PassageHit {
  return {
    passageId: String(row.passage_id),
    documentId: String(row.document_id),
    contentHash: String(row.content_hash),
    excerpt: String(row.excerpt),
    score: Number(row.score),
  };
}

/**
 * Rank the owner's passages for a question. Returns [] for tokenless
 * queries. The join against passages drops rows whose passage row has
 * disappeared; owner scoping is enforced both on the FTS mirror and the
 * joined row. `documentIds` (ANS-08) optionally restricts the candidate
 * set to those documents (question-scoped retrieval). `relevanceFloor`
 * (SRC-11, answer-time exclusion) optionally filters candidates scored
 * below the designed floor — advisory: documents with NO relevance score
 * (NULL = legacy/unmeasured) are ALWAYS included; exclusion is read-time
 * and never storage-time, and the floor is tunable at read time (not a
 * cache-key input — source versions unchanged). `noiseFilter` (SRC-12,
 * answer-time exclusion) drops passages flagged at store time with a
 * noise class — advisory in the same shape: NULL (unclassified/legacy)
 * is ALWAYS included, and the filter is byte-identical when omitted.
 */
export async function searchPassages(
  client: Client,
  ownerId: string,
  queryText: string,
  limit = 10,
  documentIds?: string[],
  relevanceFloor?: number,
  noiseFilter?: boolean,
): Promise<PassageHit[]> {
  const match = buildMatchQuery(queryText);
  if (match === null) return [];
  const docFilter =
    documentIds && documentIds.length > 0
      ? ` AND p.document_id IN (${documentIds.map(() => "?").join(", ")})`
      : "";
  const floorFilter =
    relevanceFloor === undefined
      ? ""
      : " AND (d.relevance_score IS NULL OR d.relevance_score >= ?)";
  const noiseClause = noiseFilter === true ? " AND p.noise_class IS NULL" : "";
  const res = await client.execute({
    sql: `SELECT f.passage_id, p.document_id, d.content_hash, f.excerpt, bm25(passages_fts) AS score
          FROM passages_fts f
          JOIN passages p ON p.id = f.passage_id AND p.owner_id = ?
          JOIN documents d ON d.id = p.document_id
          WHERE passages_fts MATCH ?
            AND f.owner_id = ?${docFilter}${floorFilter}${noiseClause}
          ORDER BY score
          LIMIT ?`,
    args: [
      ownerId,
      match,
      ownerId,
      ...(documentIds && documentIds.length > 0 ? documentIds : []),
      ...(relevanceFloor === undefined ? [] : [relevanceFloor]),
      limit,
    ],
  });
  return res.rows.map(hitFromRow);
}
