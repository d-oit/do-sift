-- 0003: reservation deadlines for atomic budgets (CORE-05).
-- Additive column; historical rows predate deadlines and stay NULL.
ALTER TABLE usage_ledger ADD COLUMN expires_at TEXT;
