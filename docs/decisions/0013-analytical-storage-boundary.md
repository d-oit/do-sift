# 0013 — Operational database and analytical storage boundary

- **Status:** Accepted (2026-11-17)
- **Issue:** #153
- **Supersedes:** none

## Context

do-sift stores owners, tenants, permissions, research runs, jobs, budgets,
evidence, documents, passages, provenance, and transactional cache state in
libSQL/SQLite. Recent proposals suggested DuckDB and Parquet. They solve
different workloads: DuckDB is a columnar analytical engine and Parquet is an
immutable file format. Neither is a transactional store for the entities above.

The risk is a second source of truth: an analytics copy that silently diverges
from the operational rows, or a request path that reaches an analytical engine.

## Decision

1. **libSQL/SQLite remains the sole operational source of truth.** No
   operational entity may be authored, mutated, or authorised from an
   analytical store or a snapshot.
2. **Analytics is optional, read-only, and outside the request path.** It
   consumes versioned snapshots or explicitly bounded read-only exports. It
   never writes operational tables.
3. **Parquet is an interchange/snapshot format, not an operational database.**
   Snapshots are immutable, versioned, checksummed, and validated on read.
4. **DuckDB is adopted for optional offline analytics only.** The gate in
   `plans/046-analytics-benchmark.md` measured an 11.7× faster aggregation,
   0.16× peak RSS, and identical results at 100k rows, so an isolated analytics
   package may use it. It remains absent from root dependencies, shared
   contracts, and the request path, and the operational source of truth stays
   libSQL/SQLite.
5. **No distributed writers.** If DuckDB is ever adopted, it is single-writer
   per file (or in-memory/per-run), never a shared writable file across
   service processes.

## Data flow

```
plugins / HTTP / CLI
        │  (transactions)
        ▼
  libSQL / SQLite  ── read-only deterministic export ──▶  versioned snapshot
  (authoritative)                                          (Parquet or JSON)
                                                                  │
                                                                  ▼
                                                         offline analytics
                                                         (reports, evals)
```

## Alternatives considered

| Option                  | Why not now                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| libSQL/SQLite only      | Sufficient for the current corpus; no analytical engine needed yet.                 |
| DuckDB as primary store | Not a transactional operational store; single-writer and multi-process constraints. |
| PostgreSQL              | Operationally heavier than the current single-owner deployment; no measured need.   |
| ClickHouse              | Designed for large-scale OLAP clusters; far outside this product's scale.           |
| Parquet-only workflow   | Parquet cannot serve transactional reads/writes or point updates.                   |

## Non-goals

- Replacing libSQL.
- Adding a graph database.
- Introducing a data lake, catalog, or distributed query engine.
- Enabling multi-process DuckDB writes.
- Adding an analytics dependency to root or shared contracts.

## Consequences

- Snapshot exports must carry a schema version, dataset version, code
  revision, row count, and content checksum, and must reject unknown
  incompatible versions with a clear error.
- Report generation is deterministic and requires no credentials or network.
- The application builds, tests, and runs with analytics entirely absent.
- Missing metadata is represented as `unknown`; a report never fabricates a
  price, date, or reliability score.
