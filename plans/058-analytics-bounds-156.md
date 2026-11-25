# Plan 058 — Analytics resource bounds for issue #156

Status: done (slice, 2026-11-25). Owner: maintainer. Follows plans 046 (adopt gate),
047 (isolated package), 057 (multi-size closeout).

Issue #155 (Parquet) stays deferred per plans 052 + 057: no consumer needs
Parquet yet, JSON snapshots stand. This slice does not add a Parquet reader.
Issue #156 acceptance criteria that remain open after 047:

- query execution has explicit resource bounds and cancellation;
- graceful failure modes (too much input, cancelled, timed out) with tests;
- platform/binary documentation for the isolated package.

Out of scope: Parquet I/O, new analytical queries, CLI flags, request-path
use. The CLI keeps calling `aggregateEvalResults(rows)` with defaults; the
defaults themselves are the bound.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                                 | Preconditions                                                 | Sensor  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------- |
| ANB-01 | Bounds + cancellation in `@do-sift/analytics`: `AggregateOptions` (`signal`, `timeoutMs`, `maxRows`), defaults, deterministic errors | Plan row exists (this file); issue #156 criteria quoted above | `tests` |
| ANB-02 | Tests: over-limit rejection, pre-aborted signal, zero timeout, defaults still aggregate                                              | ANB-01 red tests written first                                | `tests` |
| ANB-03 | Docs: resource-bounds + platform section in package README or src header                                                             | ANB-01 implemented                                            | `links` |
| ANB-04 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                                        | ANB-01..03 green                                              | `evals` |

## Evidence (2026-11-25, branch `docs/058-analytics-bounds-156`)

- `npx vitest run packages/analytics/test/aggregate.test.ts` — PASS 7/7 (4 pre-existing + 3 new: over-limit, pre-aborted, zero-timeout).
- `npm run check:fast` — PASS 9/9.
- `npm run check` — PASS 12/12 (tests + evals + build).
- `npm run signals -- verify --set feedback` — green.
- Red before green: 3 new tests failed before `AggregateOptions` existed (3 failed / 4 passed), then passed after.
- Files changed: `packages/analytics/src/index.ts` (bounds + docs header), `packages/analytics/test/aggregate.test.ts` (3 tests), this plan.
- review-security: no new trust boundary (in-memory fixed SQL, caller rows only); abort/timeout are fail-closed; no SSRF/injection/authz/money/plugin/workflow surface.

Method: vertical-event-slice (behavior understood; no third-party
uncertainty beyond the known DuckDB JS API). No spike: the API surface is
`DuckDBInstance.create(":memory:")` + fixed SQL, already exercised in
`packages/analytics/src/index.ts`.

## Decision notes

- In-memory only (`:memory:`), fixed SQL, caller-supplied rows. No shared
  DuckDB file, no second writer, no arbitrary SQL from callers.
- Cancellation is cooperative: the DuckDB JS binding has no mid-query abort;
  the implementation checks `signal` at entry and around the DuckDB steps and
  races a timeout timer against the operation. A mid-query abort surfaces at
  the next checkpoint, not mid-scan. Documented, not hidden.
- Defaults: `maxRows = 200_000` (above the 100k gate size, below the 250k+
  memory climb in plan 057), `timeoutMs = 30_000` (500k aggregates in <1s on
  the 057 sandbox; 30s is a guard, not a budget).
