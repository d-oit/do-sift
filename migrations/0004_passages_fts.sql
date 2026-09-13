-- 0004: FTS5 retrieval index over passages (SRC-04, ADR 0002).
-- Kept in sync transactionally by the passages repository on insert; the
-- retrieval baseline is FTS5/bm25 only — vector columns are a later,
-- gated migration (plan 007) and must never mix into this index.
CREATE VIRTUAL TABLE passages_fts USING fts5(
  passage_id UNINDEXED,
  owner_id UNINDEXED,
  excerpt,
  tokenize = 'porter unicode61'
);
