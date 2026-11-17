# 046 — Analytics benchmark decision gate (#154)

Status: decided — adopt for optional offline analytics (2026-11-17). Owner: maintainer.

## Hypothesis

DuckDB materially outperforms the existing libSQL/SQLite + TypeScript path for
offline evaluation/reporting workloads, without an unacceptable dependency or
deployment cost.

## Decision rule (set before measuring)

Adopt only if **all** hold on a representative, deterministically generated
dataset:

- at least a **2×** reduction in wall time on an aggregation workload at
  100k+ rows, repeated three times with the direction stable;
- equivalent result sets (no semantic drift);
- no more than **1.5×** peak RSS;
- prebuilt binaries for the supported OS/Node matrix, or a documented
  build-free fallback;
- no operational dependency added to the request path.

Marginal or unrepeatable gains do not justify adoption.

## What was done in this slice

- `scripts/bench/analytics-bench.ts` generates a deterministic dataset and
  measures the existing aggregation path (group counts, aggregate recall and
  latency, peak RSS), recording Node version, OS, row count, seed, and the full
  nine-row result set so equivalence can be checked mechanically.
- A throwaway spike under the gitignored `.spikes/duckdb-bench/` ran the same
  generator and query through `@duckdb/node-api` 1.4.1-r.5, with the same
  machine-readable output (full result set included). No production dependency
  was added; the spike is not committed.

## Result

**Adopt for optional offline analytics.** On win32/x64, Node 24.9.0, 100,000
rows, seed 42, three runs each:

| Metric (median)         | libSQL/SQLite |   DuckDB | Ratio | Gate               |
| ----------------------- | ------------: | -------: | ----: | ------------------ |
| Aggregation query       |        315 ms |    27 ms | 11.7× | ≥ 2× faster — pass |
| Peak RSS                |        556 MB |    91 MB | 0.16× | ≤ 1.5× — pass      |
| Result set              |      9 groups | 9 groups | equal | no drift — pass    |
| Request-path dependency |          none |     none |     — | none added — pass  |

Load time (DuckDB appender ~591 ms vs libSQL batched inserts ~7,911 ms) is
recorded but excluded from the gate: the loaders are not equivalent work.

Caveats recorded before building an adapter:

- Only win32/x64 Node 24 was measured for the gate. The isolated
  `packages/analytics` package and its CI matrix (Linux 24/26, macOS 24,
  Windows 24) are the verification that the prebuilt bindings actually load on
  each supported runner.
- Peak RSS includes the dataset generator; the direction (DuckDB far below the
  baseline) is stable across all three runs.
- The win32 bindings cover x64 only; Windows arm64 is not a supported target.

## Reproduce

```bash
npx tsx scripts/bench/analytics-bench.ts --rows 100000
```

The harness prints machine-readable JSON, including every group, so a DuckDB
run can be compared value by value. The spike script that produced the numbers
above lived in `.spikes/duckdb-bench/` (gitignored) with
`@duckdb/node-api@1.4.1-r.5`; it uses the same `mulberry32` generator and the
same `GROUP BY provider, dataset` query. Recreate it there rather than adding
the dependency to the repository.
