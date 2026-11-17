-- 0014: research workspaces — collections and annotations (issue #168).
--
-- Expand-only: collections reference existing research runs and evidence rows;
-- nothing is copied out of documents/passages/answers. Every table carries
-- (tenant_id, owner_id) and the repositories filter on both, so a collection
-- can never cross a tenant or owner boundary.
--
-- Notes are author-authored metadata, explicitly distinct from fetched
-- evidence: they are never rendered as source text and never sent to a model
-- as evidence. `author_id` records who wrote the note; it is not the owner of
-- the underlying evidence.
--
-- Rollback: drop the three tables (nothing else references them). The
-- collections are metadata, so deleting them loses no evidence.
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX idx_collections_tenant_owner
  ON collections(tenant_id, owner_id, created_at DESC, id DESC);

CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('run', 'evidence')),
  item_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, item_kind, item_id)
);

CREATE INDEX idx_collection_items_tenant_owner
  ON collection_items(tenant_id, owner_id, collection_id);

CREATE TABLE collection_notes (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 8000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_collection_notes_tenant_owner
  ON collection_notes(tenant_id, owner_id, collection_id, created_at);

-- Owner/tenant consistency with the existing owners table.
CREATE TRIGGER collections_tenant_insert BEFORE INSERT ON collections
FOR EACH ROW WHEN (
  SELECT COUNT(*) FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) = 0 BEGIN
  SELECT RAISE(ABORT, 'collections: tenant_id does not match the owner''s tenant');
END;

CREATE TRIGGER collections_tenant_update BEFORE UPDATE OF tenant_id, owner_id ON collections
FOR EACH ROW WHEN (
  SELECT COUNT(*) FROM owners o WHERE o.id = NEW.owner_id AND o.tenant_id = NEW.tenant_id
) = 0 BEGIN
  SELECT RAISE(ABORT, 'collections: tenant_id does not match the owner''s tenant');
END;

-- An item may only reference a collection in the same tenant and owner.
CREATE TRIGGER collection_items_scope_insert BEFORE INSERT ON collection_items
FOR EACH ROW WHEN (
  SELECT COUNT(*) FROM collections c
  WHERE c.id = NEW.collection_id
    AND c.tenant_id = NEW.tenant_id
    AND c.owner_id = NEW.owner_id
) = 0 BEGIN
  SELECT RAISE(ABORT, 'collection_items: collection scope does not match the item scope');
END;

CREATE TRIGGER collection_items_scope_update
BEFORE UPDATE OF collection_id, tenant_id, owner_id ON collection_items
FOR EACH ROW WHEN (
  SELECT COUNT(*) FROM collections c
  WHERE c.id = NEW.collection_id
    AND c.tenant_id = NEW.tenant_id
    AND c.owner_id = NEW.owner_id
) = 0 BEGIN
  SELECT RAISE(ABORT, 'collection_items: collection scope does not match the item scope');
END;

CREATE TRIGGER collection_notes_scope_insert BEFORE INSERT ON collection_notes
FOR EACH ROW WHEN (
  SELECT COUNT(*) FROM collections c
  WHERE c.id = NEW.collection_id
    AND c.tenant_id = NEW.tenant_id
    AND c.owner_id = NEW.owner_id
) = 0 BEGIN
  SELECT RAISE(ABORT, 'collection_notes: collection scope does not match the note scope');
END;

CREATE TRIGGER collection_notes_scope_update
BEFORE UPDATE OF collection_id, tenant_id, owner_id ON collection_notes
FOR EACH ROW WHEN (
  SELECT COUNT(*) FROM collections c
  WHERE c.id = NEW.collection_id
    AND c.tenant_id = NEW.tenant_id
    AND c.owner_id = NEW.owner_id
) = 0 BEGIN
  SELECT RAISE(ABORT, 'collection_notes: collection scope does not match the note scope');
END;
