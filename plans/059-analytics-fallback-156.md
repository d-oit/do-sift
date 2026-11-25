# Plan 059 — Analytics missing-DuckDB fallback for issue #156

Status: in-progress (slice, 2026-11-25). Owner: maintainer. Follows plan 058
(bounds + cancellation). Issue #156 requires "make absence of DuckDB a
supported configuration"; currently `packages/analytics/src/index.ts` has a
static `import { DuckDBInstance } from "@duckdb/node-api"`, so a missing
binding breaks the whole package import.

Out of scope: Parquet I/O (#155 deferred), new queries, CLI flags,
request-path use. CLI keeps lazy-importing `@do-sift/analytics` with
defaults; the fallback is inside the package.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                                               | Preconditions                                                     | Sensor  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| ANF-01 | JS fallback engine in `@do-sift/analytics`: dynamic DuckDB import, `DO_SIFT_ANALYTICS_ENGINE=javascript` override, identical deterministic results | Plan row exists (this file); #156 fallback criterion quoted above | `tests` |
| ANF-02 | Tests (red first): JS-forced parity with DuckDB on deterministic set, concurrent `Promise.all` aggregations, empty-input JS path                   | ANF-01 red tests written first                                    | `tests` |
| ANF-03 | Docs: fallback + engine-override section in src header                                                                                             | ANF-01 implemented                                                | `links` |
| ANF-04 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                                                      | ANF-01..03 green                                                  | `evals` |

## Evidence (2026-11-25, branch `docs/059-analytics-fallback-156`)

- Red: 3 new tests failed before `aggregateJs` existed (3 failed / 7 passed).
- Green: `npx vitest run packages/analytics/test/aggregate.test.ts` — PASS 10/10.
- `npm run check:fast` — PASS 9/9 (after prettier write on test + plan).
- `npm run check` — PASS 12/12 (tests + evals + build).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (caller rows only, fixed SQL,
  read-only env override with exact-match check); fallback is fail-open to
  identical-shape results, not to untrusted input. Residual: float means may
  differ from DuckDB AVG in the last ulp on large sets; grouping and order
  are identical and small-set parity is exact.

Method: vertical-event-slice (behavior understood; DuckDB JS API already
exercised). No spike: dynamic `import()` failure mode is standard ESM.

## Decision notes

- DuckDB stays the default engine when its binding imports cleanly.
- Fallback is pure TypeScript grouping with the same sort order
  (provider, dataset) and the same statistics; no SQL, no files.
- Forced JS path is for tests and for hosts without a binding (e.g.
  Windows arm64, minimal containers): `DO_SIFT_ANALYTICS_ENGINE=javascript`.
  Any other value (or unset) means "try DuckDB first, fall back on
  import failure".
- Validation (row shape, duplicates, maxRows, abort, timeout) runs before
  engine selection so both engines reject the same inputs.
