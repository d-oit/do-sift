-- ANS-07 (R-15/F9, plan 004): link stored evidence to the research run
-- that fetched it, and record each answer's evidence basis so an answer
-- can never present cross-question leftovers as grounded work for a
-- question whose own run stored nothing.
--
-- Purely additive (expand): existing rows keep NULL. NULL request_id on
-- documents means "legacy / pre-ANS-07 evidence" and is reported as
-- legacy, never counted as from-run. Rollback story: restore from a
-- pre-migration backup (ALTER TABLE ... ADD COLUMN has no clean
-- downgrade; nothing else breaks — see ANS-07 evidence).
ALTER TABLE documents ADD COLUMN request_id TEXT REFERENCES requests(id);
ALTER TABLE answers ADD COLUMN evidence_from_run TEXT;
