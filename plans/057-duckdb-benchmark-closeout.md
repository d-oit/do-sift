# Plan 057 — DuckDB benchmark closeout for issue #154

Status: done (2026-11-23). Owner: maintainer. Follows
`plans/046-analytics-benchmark.md` (decision already recorded: adopt optional
offline analytics) and closes the remaining acceptance criteria of issue #154
that 046/045/052 left open:

- at least three dataset sizes with deterministic generation and repeated-run
  variance (046 recorded a single 100k size);
- storage/file size alongside latency and memory;
- full environment metadata (CPU, RAM, Node, OS, libSQL version, DuckDB
  version, seed, commands);
- cold and warm query runs with p50/p95;
- Parquet scan/export measured separately from DuckDB database operations
  (052 deferred the Parquet _writer_ without a measurement; this measures);
- a per-workload benefit report and a restated explicit decision.

## Decision rule (inherited from plan 046, unchanged)

Adopt only with ≥2× wall-time reduction on an aggregation workload at 100k+
rows across three runs with stable direction, equivalent result sets, ≤1.5×
peak RSS, prebuilt binaries for the supported OS/Node matrix, and no
request-path dependency. Marginal or unrepeatable gains do not justify
adoption. Parquet stays deferred per plan 052's gate; this slice only measures
scan/export cost, it does not promote a writer.

## Subtasks (htn-planner, ordered)

1. BNQ-01 — harness: `--runs` repeated query timing (cold + warm, p50/p95),
   `--disk` / `--disk-only` storage-size measurement, full env metadata
   (CPU model, total RAM, libSQL version), identical-results assertion. DONE.
2. BNQ-02 — baseline runs at 10k / 100k / 250k / 500k recorded. DONE. The 1M
   point is a finding, not a completed size: the libSQL path is OOM-killed at
   this sandbox's ~6 GB RAM limit in both memory and on-disk modes (exit 137),
   while DuckDB completes 1M in the same sandbox. 500k on-disk stands in as
   the largest completed libSQL size; three completed sizes beyond the gate's
   100k are recorded, and the limit is justified (6 GB RAM sandbox) rather
   than hidden.
3. BNQ-03 — spike (`.spikes/duckdb-bench/`, gitignored): DuckDB comparison at
   10k/100k/250k/500k/1M with the same generator and query, mechanical
   result-set equality check, exit 0 = checks passed. DONE (exit 0).
4. BNQ-04 — same spike: Parquet export (COPY TO), file size, full-aggregate
   scan read-back, and projection/filter pushdown, measured separately from
   the database table. DONE.
5. BNQ-05 — per-workload benefits, restated decision, scratch removed. DONE.

## Environment (all numbers below)

linux/x64, Node v22.23.5, Intel(R) Xeon(R) 6985P-C @ 2.30GHz, 6 GB RAM,
`@libsql/client` 0.18.0, DuckDB v2.0.1 via `@duckdb/node-api` 2.0.1-r.1 (npm
dist-tag `latest`, resolved 2026-11-23), dataset seed 42, 3 query runs per
size (first = cold). The sandbox Node is below the repo's declared `>=24`
floor, so these numbers are recorded for the multi-size/variance requirement
and are **not** merged into plan 046's gate set (produced on Node 24 /
win32); thresholds and direction are what carry over.

## Results — libSQL/SQLite baseline (`npm run bench:analytics`)

| Rows | Mode        |      Load (ms) | Query p50 | Query p95 | Peak RSS | On-disk size |
| ---- | ----------- | -------------: | --------: | --------: | -------: | -----------: |
| 10k  | memory+disk |            143 |      5 ms |      5 ms |   193 MB |      0.65 MB |
| 100k | memory+disk |          2,306 |     51 ms |     89 ms |   934 MB |       6.6 MB |
| 250k | memory+disk |          3,380 |    148 ms |    148 ms | 2,112 MB |      16.8 MB |
| 500k | disk-only   |         10,698 |    345 ms |    383 ms | 2,130 MB |      33.9 MB |
| 1M   | —           | OOM (exit 137) |         — |         — |        — |            — |

Commands: `npm run bench:analytics -- --rows <N> --runs 3 --disk`
(`--disk-only` for 500k). Determinism: 9 groups, `resultsIdentical: true` on
every completed run, sum of group counts == row count.

## Results — DuckDB (spike, same generator and query)

| Rows | Load (ms, appender) | Query p50 | Parquet export | Parquet file | Parquet scan (full agg) | Filtered projection+pushdown |
| ---- | ------------------: | --------: | -------------: | -----------: | ----------------------: | ---------------------------: |
| 10k  |                  26 |      3 ms |           8 ms |      0.12 MB |                    5 ms |                         4 ms |
| 100k |                 143 |      6 ms |          36 ms |      0.85 MB |                    5 ms |                         4 ms |
| 250k |                 338 |      7 ms |          48 ms |       2.1 MB |                    6 ms |                         5 ms |
| 500k |                 737 |      9 ms |          71 ms |       4.2 MB |                    6 ms |                         6 ms |
| 1M   |               1,376 |     13 ms |         155 ms |       8.4 MB |                   10 ms |                         8 ms |

Parquet scan/export was measured against `read_parquet(...)` directly (no
database table involved) for scan/projection, and via `COPY ... TO` for
export — separate from the DuckDB table operations above, per the issue.

## Correctness / equivalence

- Cross-engine: DuckDB result sets are equal to the libSQL result sets within
  1e-9 relative tolerance at 10k/100k/250k/500k (1M has no libSQL baseline
  because of the OOM above; DuckDB's own total group count matches 1M).
- Run-to-run: bitwise-identical at 10k–250k; at 500k/1M DuckDB's parallel
  float aggregation varies in the last bits across runs (tolerance match
  still passes). Recorded rather than hidden; the count columns are exact
  everywhere.

## Which workloads benefit (the report the issue asks for)

- **Benefits — large historical snapshot filtering/export**: Parquet export is
  48–155 ms up to 1M rows and ~4× smaller than the equivalent on-disk SQLite
  file (8.4 MB vs 33.9 MB at 500k); projection/filter pushdown reads are
  single-digit milliseconds. This is the workload where a Parquet/Arrow path
  would pay, if a consumer ever needs it.
- **Benefits — evaluation-result aggregation at scale**: 8.5× (100k) to 38×
  (500k) query-time advantage on this sandbox, and DuckDB completes 1M rows
  where libSQL OOMs. Aggregation grounds plan 046's adopt decision.
- **Does not benefit — small/interactive sizes**: at 10k rows the query is
  5 ms (libSQL) vs 3 ms (DuckDB); libSQL is already far below any perceptible
  threshold. Migration cost would buy nothing here.
- **Does not benefit — request-path workloads**: adopted DuckDB is offline
  and isolated (`@do-sift/analytics`); libSQL stays the operational store
  (ADR 0013). No request-path numbers were re-measured because the boundary
  already excludes DuckDB from that path.
- **Load asymmetry is real but bounded**: DuckDB appender load (~1.4 s at 1M)
  beats libSQL batched inserts (~10.7 s at 500k, 2.3 s at 100k) on this
  sandbox too, but loaders are not equivalent work and stay out of the gate.

## Restated decision

**Adopt optional DuckDB for offline analytics — unchanged** (decided plan 046,
2026-11-17; thresholds pass again on a second environment with more sizes).
Parquet remains **deferred** per plan 052: scan/export is cheap and small, but
no consumer needs it yet, so the promotion gate still applies.

## Task IDs

| ID     | Task                                              | Status | Evidence                                                                                                                      |
| ------ | ------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| BNQ-01 | Harness: runs/p95, disk size, env metadata        | done   | `scripts/bench/analytics-bench.ts`; `npm run bench:analytics -- --rows 10000 --runs 3 --disk` PASS (`resultsIdentical: true`) |
| BNQ-02 | Baselines at 10k/100k/250k/500k (1M OOM recorded) | done   | Commands above; tables in this plan; exit 137 recorded for 1M on the 6 GB sandbox                                             |
| BNQ-03 | DuckDB spike at three+ sizes, equality check      | done   | `.spikes/duckdb-bench/spike.mjs` exit 0; equivalence section above                                                            |
| BNQ-04 | Parquet scan/export spike measurement             | done   | Same spike, `parquet` section, exit 0; table above                                                                            |
| BNQ-05 | Per-workload report, decision, scratch removed    | done   | "Which workloads benefit" + "Restated decision" above; `.spikes/` contents deleted (gitignored)                               |

## Verification

- `npm run eval:offline` — PASS (42 deterministic cases, 0 external network
  calls, 0 paid model calls, degradationHonesty 1.000 8/8).
- `npm run check:fast` — PASS 9/9 (format, lint, typecheck, policy,
  guardrails, skills, governance, links, deps).
- `npm run signals -- verify --set feedback` — verdict green.
- `node .spikes/duckdb-bench/spike.mjs` — exit 0 (mechanical cross-engine
  equivalence + determinism checks at every size before scratch deletion).

## Risks / open questions

- The 1M libSQL OOM is a 6 GB sandbox limit, not an inherent engine limit;
  plan 046's Node 24 environment recorded 556 MB RSS at 100k. If a future
  consumer needs 1M+ rows through libSQL, that is a memory-bound review, not
  a reason to change this decision.
- DuckDB `latest` (2.0.x) vs plan 046's 1.4.1-r.5: both pass; the isolated
  `packages/analytics` package pins its own version and CI matrix.
