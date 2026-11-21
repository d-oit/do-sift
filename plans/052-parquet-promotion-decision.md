# Plan 052 — Parquet writer promotion decision (#155)

Status: decided — defer (2026-11-21). Owner: maintainer.

Plan 045 left the Parquet writer as a separate promotion decision: the
snapshot schema/manifest/checksum contract landed and is tested with JSON
interchange (`packages/contracts/src/snapshot.ts`, `scripts/snapshot.ts`),
and the DuckDB result (plan 046) does not imply Parquet adoption. This plan
records the decision.

## Decision rule (set before assessing)

Promote a Parquet writer only if **all** hold:

- a measured interchange need: snapshots too large/slow as JSON for a real
  offline consumer, or a second tool that requires Parquet input;
- deterministic round-trip: Parquet preserves the schema, manifest, and
  checksum semantics in `packages/contracts/src/snapshot.ts` with identical
  bytes after read-back;
- prebuilt binaries for the supported OS/Node matrix (Linux 24/26, macOS 24,
  Windows 24), or a documented build-free fallback;
- no operational dependency added to the request path, root dependencies, or
  shared contracts (ADR 0013 boundary holds).

A plausible-but-unmeasured need does not justify a native dependency.

## Assessment

- Snapshots are tiny deterministic eval artifacts: `scripts/snapshot.ts`
  writes canonical JSON plus a manifest; plan 045's evidence wrote 2 rows.
- The analytics consumer (`packages/analytics`) takes in-memory rows and
  aggregates with DuckDB; there is no Parquet-reading consumer anywhere in
  the repo (13 `parquet` mentions are docs/plans/contracts, no writer).
- No cross-tool Parquet requirement exists; no size/latency pain is recorded.
- Native-dependency cost is real and recent: the onnxruntime-node Linux 404
  flaked CI, and win32/arm64 has no DuckDB binding precedent.

## Decision

**Defer.** JSON interchange stays the snapshot format. Revisit only with a
measurement that trips the gate above; the gate, not enthusiasm, promotes it.

## Task IDs

| ID     | Task                                                                | Status |
| ------ | ------------------------------------------------------------------- | ------ |
| PAR-01 | Record defer decision + promotion gate here and in the README queue | done   |

## Evidence

- `packages/contracts/src/snapshot.ts`: JSON interchange implemented and tested without a native dependency.
- `packages/analytics/src/index.ts`: in-memory DuckDB aggregation, no Parquet I/O.
- Code search `parquet` (2026-11-21): docs/plans/contracts only, no writer or reader.
- ADR 0013: Parquet is an interchange/snapshot format, never an operational store.
