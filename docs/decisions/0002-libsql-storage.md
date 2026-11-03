# 0002 — libSQL for durable storage

Status: accepted (first recorded 2026-09-06 in `plans/adr/0002-libsql-and-storage.md`)

## Context

The engine needs a few gigabytes of relational data — documents, passages,
answers, a usage ledger, a job queue — with full-text search and, later,
vector search, reachable from TypeScript, with no server to operate and a
usable free tier. The evidence model also needs transactions: a citation must
never point at a passage that was rolled back.

## Decision

Durable storage is **Turso Cloud on libSQL**, accessed through
`@libsql/client`. Development and deterministic tests use a **local libSQL
file** and an in-memory database.

Two deliberate narrowings:

- We target **libSQL**, not stock SQLite and not the newer Turso engine.
  FTS5 and vector behaviour are verified against the provisioned database
  before a migration relies on them.
- Migrations are **forward-only and expand/contract**: add the new shape,
  backfill, switch reads, then drop. A rollback is a restore, not a down
  migration.

## Consequences

- One client library for hosted, file, and in-memory; tests run the real
  migrations against `:memory:` (`applyMigrations(client, loadMigrations("migrations"))`).
- FTS5 gives the bm25 baseline a native ranker, which is why retrieval starts
  there ([0006](0006-hybrid-retrieval.md)).
- Free-tier limits are a real constraint, not a footnote: quotas are recorded
  with a checked date in `plans/sources.md`, and ingestion pauses before
  ceilings.
- No down migrations means a bad migration is recovered from a backup. Paste
  copy requires a backup and a restore rehearsal.
- Tenant scoping rides on the same schema: `tenant_id` columns plus triggers
  that abort a write whose `(tenant_id, owner_id)` pair does not match an
  owners row ([multi-tenant-auth.md](../multi-tenant-auth.md)).
