# ADR 0002 — Turso libSQL for durable storage

Status: accepted 2026-09-06

## Context

We need a few-GB store with relational data, full-text search, and (later)
vector search, reachable from TypeScript, with a usable free tier and no
server to operate.

## Decision

Primary durable storage is **Turso Cloud using libSQL** (`@libsql/client`).
Development and deterministic tests use a **local libSQL file**. We target
libSQL specifically — not stock SQLite and not the newer Turso engine — and
verify FTS5 and `libsql_vector_idx` behavior against the provisioned database
before the first migration (gate recorded in `plans/sources.md`).

## Consequences

- Free tier (checked 2026-09-06): 5 GB storage, 500 M row reads, 10 M row
  writes monthly. We track size and usage and suspend optional ingestion
  before ceilings.
- Start with FTS5 retrieval; vectors only after beating that baseline (RET).
- Local-vs-hosted parity is tested in integration tests; a connection URL
  change alone is never assumed to migrate or replicate anything.
- Expand/contract migrations; backup before destructive change.
