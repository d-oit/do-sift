-- 0012: membership change log (issue #120, plan 024 — MT-10).
-- Append-only audit trail for tenant membership edits. One row per change made
-- through the admin surface (or an operator script), recording who acted and
-- what the role was before and after, so an owner can review role changes
-- after the fact.
--
-- Rows are never updated or deleted by application code: the table is a log,
-- not state. `from_role` is NULL for the first grant, `to_role` is NULL for a
-- removal. `id` is monotonic, so "newest first" is an index seek per tenant.
CREATE TABLE tenant_member_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'role-changed', 'removed')),
  from_role TEXT CHECK (from_role IS NULL OR from_role IN ('owner', 'member', 'viewer')),
  to_role TEXT CHECK (to_role IS NULL OR to_role IN ('owner', 'member', 'viewer')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_tenant_member_changes_tenant ON tenant_member_changes(tenant_id, id DESC);
