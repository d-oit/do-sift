# Plan 060 — Reproducible retrieval report for issue #157

Status: in-progress (slice, 2026-11-25). Owner: maintainer. Follows plans
058/059 (#156 bounds + fallback). Issue #157 asks for small, high-value,
read-only reports that reuse eval outputs, carry provenance, use
deterministic aggregation with explicit missing-data semantics, and make no
unsupported quality claims.

This slice implements exactly one report — retrieval quality by
(provider, dataset) — as a pure function over `EvalResultRow[]` in
`packages/analytics/src/report.ts`, re-exported from the package index. No
Parquet I/O (#155 deferred), no clinical claims, no request-path use.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                           | Preconditions                                           | Sensor  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------- |
| RPT-01 | `buildRetrievalReport(rows, provenance)` with p50/p95 latency gated on sample size, deterministic order, empty-input semantics | Plan row exists (this file); #157 criteria quoted above | `tests` |
| RPT-02 | Tests (red first): ordering, provenance echo, empty input, p50/p95 gating, malformed-row rejection                             | RPT-01 red tests written first                          | `tests` |
| RPT-03 | Docs: report contract in src header (provenance fields, percentile gate, no-timestamp reproducibility)                         | RPT-01 implemented                                      | `links` |
| RPT-04 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                                  | RPT-01..03 green                                        | `evals` |

## Evidence (2026-11-25, branch `docs/060-reports-157`)

- Red: `report.test.ts` failed to import before `src/report.ts` existed
  (1 file failed, no tests).
- Green: `npx vitest run packages/analytics` — PASS 14/14 (10 aggregate +
  4 report: ordering/provenance, empty input, p50/p95 gating, malformed
  rejection).
- `npm run check:fast` — PASS 9/9 (after prettier write on the plan file).
- `npm run check` — PASS 12/12 (tests + evals + build).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (caller rows + caller-supplied
  provenance echoed as JSON data, no HTML rendering, no network/files/
  privilege; fixed grouping, validated rows via `aggregateEvalResults`).
  Residual: provenance is caller-attested, not verified — consumers must not
  treat echoed versions as verified facts.

Method: vertical-event-slice. No spike: pure deterministic grouping, no
third-party API.

## Decision notes

- Input is `EvalResultRow[]` (existing eval schema); no new framework.
- Provenance is caller-supplied `{ datasetVersion, baselineVersion,
codeRevision, reportVersion }` and echoed verbatim; the report carries no
  wall-clock timestamp so identical inputs produce identical outputs.
- p50/p95 latency use the nearest-rank method on sorted latencies and are
  emitted only when `n >= 5`; otherwise `null` with reason
  `"insufficient-sample"`. Follows #157's "p50/p95 only when sample size is
  sufficient" without inventing a statistics framework.
- Missing data is explicit: empty input yields `groups: []` with
  `rowCount: 0`; no imputation, no domain-reputation inference, no
  engagement-as-correctness.
