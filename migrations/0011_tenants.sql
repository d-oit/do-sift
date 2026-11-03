-- 0011: tenants + tenant scoping (issue #120, plan 024).
-- Expand-only and backward compatible: every existing row is backfilled to
-- the 'default' tenant, so the single-owner allowlist deployment keeps its
-- data and behaviour unchanged. New rows carry their tenant explicitly from
-- the repository layer (packages/storage), which filters on owner_id AND
-- tenant_id for every owner-scoped statement.
--
-- Tenancy model:
--   tenants         one row per isolated workspace
--   tenant_members  which user may act inside which tenant, with a role
--   owners.tenant_id  the workspace an owner row belongs to
--
-- The tenant_id columns on the data tables are denormalized receipts: the
-- composite indexes below make "everything for tenant T" an index seek, and
-- the triggers below abort any write whose (tenant_id, owner_id) pair does
-- not match an owners row — so a scoped repository cannot file a row under a
-- tenant its owner does not belong to, even if it is handed a foreign id.
-- Rollback story: restore from a pre-migration backup (ALTER TABLE ... ADD
-- COLUMN has no clean downgrade; the columns are additive and defaulted, so
-- nothing else breaks).
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tenant_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX idx_tenant_members_user ON tenant_members(user_id, tenant_id);

-- Single-owner installs are migrated here; a host that never configures
-- tenancy keeps writing to it.
INSERT INTO tenants (id, display_name, created_at)
  VALUES ('default', 'Default tenant', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE owners ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE UNIQUE INDEX idx_owners_tenant ON owners(tenant_id, id);

ALTER TABLE documents ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_documents_tenant_owner ON documents(tenant_id, owner_id, canonical_url);

ALTER TABLE passages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_passages_tenant_owner ON passages(tenant_id, owner_id, document_id);

ALTER TABLE requests ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_requests_tenant_owner ON requests(tenant_id, owner_id, status);

ALTER TABLE answers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_answers_tenant_owner_cache ON answers(tenant_id, owner_id, cache_key);

ALTER TABLE feedback ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_feedback_tenant_owner ON feedback(tenant_id, owner_id, answer_id);

ALTER TABLE episodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_episodes_tenant_owner ON episodes(tenant_id, owner_id, created_at);

ALTER TABLE jobs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_jobs_tenant_owner_runnable
  ON jobs(tenant_id, owner_id, status, lease_until, created_at);

ALTER TABLE usage_ledger ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_usage_tenant_owner_day ON usage_ledger(tenant_id, owner_id, day);

ALTER TABLE passage_embeddings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_passage_embeddings_tenant_owner_model
  ON passage_embeddings(tenant_id, owner_id, model_id);

-- Tenant/owner consistency, enforced by the database rather than by caller
-- discipline. Each INSERT (and each UPDATE that can move a row's tenant or
-- owner) must name an owners row that actually lives in that tenant.
CREATE TRIGGER documents_tenant_insert BEFORE INSERT ON documents
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'documents: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER documents_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON documents
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'documents: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER passages_tenant_insert BEFORE INSERT ON passages
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'passages: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER passages_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON passages
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'passages: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER requests_tenant_insert BEFORE INSERT ON requests
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'requests: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER requests_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON requests
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'requests: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER answers_tenant_insert BEFORE INSERT ON answers
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'answers: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER answers_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON answers
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'answers: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER feedback_tenant_insert BEFORE INSERT ON feedback
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'feedback: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER feedback_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON feedback
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'feedback: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER episodes_tenant_insert BEFORE INSERT ON episodes
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'episodes: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER episodes_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON episodes
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'episodes: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER jobs_tenant_insert BEFORE INSERT ON jobs
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'jobs: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER jobs_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON jobs
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'jobs: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER usage_ledger_tenant_insert BEFORE INSERT ON usage_ledger
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'usage_ledger: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER usage_ledger_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON usage_ledger
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'usage_ledger: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER passage_embeddings_tenant_insert BEFORE INSERT ON passage_embeddings
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'passage_embeddings: tenant_id does not match the owner''s tenant');
END;
CREATE TRIGGER passage_embeddings_tenant_update
BEFORE UPDATE OF tenant_id, owner_id ON passage_embeddings
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) BEGIN
  SELECT RAISE(ABORT, 'passage_embeddings: tenant_id does not match the owner''s tenant');
END;
