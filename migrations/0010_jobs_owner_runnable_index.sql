-- 0010: index the jobs claim path (#64). JobQueue.leaseNext filters
-- owner_id, then status / lease_until, and orders by created_at. The 0002
-- index idx_jobs_status(status, lease_until) leads with status and omits
-- owner_id, so the owner-scoped claim could not seek on it. Forward-only:
-- the new index is created before the old one is dropped; no rows change.
CREATE INDEX idx_jobs_owner_runnable ON jobs(owner_id, status, lease_until, created_at);
DROP INDEX idx_jobs_status;
