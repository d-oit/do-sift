-- 0011: multi-tenant scoping (#120, ADR 0010).
--
-- Adds the tenant boundary the issue asks for: evidence (documents,
-- passages, passage_embeddings), runs (requests, answers, episodes, jobs,
-- usage_ledger), and feedback all carry a `tenant_id`, and the repository
-- layer filters every query on it by construction.
--
-- Expand-only and backward compatible: every existing row belongs to the
-- `default` tenant, which is exactly the single-owner deployment's scope, so
-- the owner-allowlist mode keeps working unchanged. No `REFERENCES tenants`
-- on the added columns — SQLite refuses a non-NULL default on an ALTER'd
-- foreign-key column — the tenants row is created below and referential
-- integrity is enforced by the repository layer (`tenants.ensure`).
--
-- Rollback story: restore from a pre-migration VACUUM INTO snapshot, as for
-- every applied migration; ALTER TABLE ... ADD COLUMN has no clean
-- downgrade, and nothing else breaks (all new columns are NOT NULL DEFAULT
-- 'default', so pre-0011 code keeps reading and writing valid rows).
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Fixed timestamp so the migration is deterministic; the seeded tenant is
-- infrastructure, not user data.
INSERT INTO tenants (id, display_name, created_at)
VALUES ('default', 'Default tenant', '1970-01-01T00:00:00.000Z');

ALTER TABLE owners ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE documents ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE passages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE passage_embeddings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE requests ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE answers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE feedback ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE episodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE jobs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE usage_ledger ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

-- Tenant-first indexes: every scoped query leads with tenant_id, then the
-- owner, then the predicate the query uses.
CREATE INDEX idx_owners_tenant ON owners(tenant_id, id);
CREATE INDEX idx_documents_tenant ON documents(tenant_id, owner_id, canonical_url);
CREATE INDEX idx_passages_tenant ON passages(tenant_id, owner_id, document_id);
CREATE INDEX idx_passage_embeddings_tenant ON passage_embeddings(tenant_id, owner_id, model_id);
CREATE INDEX idx_requests_tenant ON requests(tenant_id, owner_id, status);
CREATE INDEX idx_answers_tenant_cache ON answers(tenant_id, owner_id, cache_key);
CREATE INDEX idx_feedback_tenant ON feedback(tenant_id, owner_id, answer_id);
CREATE INDEX idx_episodes_tenant ON episodes(tenant_id, owner_id, created_at);
CREATE INDEX idx_jobs_tenant_runnable ON jobs(tenant_id, owner_id, status, lease_until, created_at);
CREATE INDEX idx_usage_ledger_tenant ON usage_ledger(tenant_id, owner_id, day);
