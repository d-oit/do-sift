-- 0001: foundational owner registry (CORE-01, ADR 0002).
-- Every owner-scoped table added by later migrations references owners(id).
-- Intentionally minimal: entity schemas arrive with CORE-03, each as its own
-- forward migration (expand/contract; never edit an applied migration).
CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
