-- 0005: passage embeddings for hybrid retrieval (RET-02, ADR 0009).
-- One row per (passage, model): Float32 bytes in `vector`, owner-scoped like
-- every table (ADR 0003). Brute-force cosine at dev scale — the pinned
-- client has no native vector functions (plans/011 spike); a Turso-side
-- index is an activation-gate question (plans/sources.md).
CREATE TABLE passage_embeddings (
  passage_id TEXT PRIMARY KEY REFERENCES passages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  model_id TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_passage_embeddings_owner_model ON passage_embeddings(owner_id, model_id);
