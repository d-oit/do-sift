-- 0009: key passage embeddings by (passage, model) (#55).
-- 0005 declared PRIMARY KEY (passage_id) while the schema comment and the
-- INSERT OR REPLACE writer assume one row per (passage, model): storing model
-- B silently destroyed model A's vector. Forward-only rebuild; existing rows
-- are copied unchanged, so no embedding is lost or re-keyed incorrectly.
CREATE TABLE passage_embeddings_new (
  passage_id TEXT NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  model_id TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (passage_id, model_id)
);
INSERT INTO passage_embeddings_new (passage_id, owner_id, model_id, vector, created_at)
  SELECT passage_id, owner_id, model_id, vector, created_at FROM passage_embeddings;
DROP TABLE passage_embeddings;
ALTER TABLE passage_embeddings_new RENAME TO passage_embeddings;
CREATE INDEX idx_passage_embeddings_owner_model ON passage_embeddings(owner_id, model_id);
