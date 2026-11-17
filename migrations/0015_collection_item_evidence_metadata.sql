-- 0015: evidence metadata snapshot on collection items (plan 048, RPT-05).
--
-- Why: a collection report must be buildable from the collection alone, even
-- when the caller never loaded the evidence list. These columns store the
-- provenance the report needs (url/title/fetched_at) at attach time, scoped
-- exactly like the item itself. They are a snapshot, not a live join: a later
-- change to the document does not rewrite what the collection recorded.
--
-- Expand-only. Existing rows keep NULL metadata and are omitted from a report
-- until re-attached; nothing is backfilled or re-fetched here.
--
-- Rollback: SQLite cannot drop columns in place. A reverse migration would
-- rebuild collection_items without these three columns and copy the rest; no
-- other table references them.
ALTER TABLE collection_items ADD COLUMN evidence_url TEXT;
ALTER TABLE collection_items ADD COLUMN evidence_title TEXT;
ALTER TABLE collection_items ADD COLUMN evidence_fetched_at TEXT;
