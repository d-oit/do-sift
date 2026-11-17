# 046 — Analytics benchmark decision gate (#154)

Status: deferred (2026-11-17). Owner: maintainer.

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
  measures the **existing** aggregation path (group counts, latency
  percentiles, source freshness buckets), recording Node version, OS, CPU,
  row count, and seed.
- No DuckDB dependency was added. Running the comparison requires an explicit
  opt-in install, which is outside this issue's boundary.

## Result

**Deferred.** There is no in-repo analytical workload large enough to justify
a native dependency today, and no measured comparison exists. The gate above
must be satisfied by a follow-up spike with DuckDB installed and the same
generator before #155/#156 can be promoted.

## Reproduce the baseline

```bash
npx tsx scripts/bench/analytics-bench.ts --rows 10000
npx tsx scripts/bench/analytics-bench.ts --rows 100000
```

The harness prints machine-readable JSON; variance across repeated runs is
reported rather than hidden.
