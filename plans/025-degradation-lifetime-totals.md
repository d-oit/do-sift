# 025 — Per-bucket lifetime summary in the degradation panel (DEG-08)

Status: done (2026-11-02). Follow-up to plans 022/023/024 (issue #127).

## Goal

The trend table shows adjacent-run deltas, but nothing says how often a
receipt has appeared across the whole recorded trail. A run that emitted
`model-failed` stops being visible as soon as the next run is recorded, and
the reader has to sum a column by eye. Add a lifetime total row so the
composition of the whole history is one glance away.

## Task table

| ID | Task | Status |
| ------ | ------------------------------------------- | ----------- || DEG-08 | Sum each reason bucket across recorded runs | done |

## Approach

- `scripts/evals-dashboard.ts`: `summarizeReasonTotals(history)` returns the
  run count, the per-bucket sum of emitted receipts, and how many runs emitted
  each bucket at least once. Empty history yields an all-zero summary.
- The trend table gains a `<tfoot>` "Lifetime total · N run(s)" row: passed
  scenarios summed, each bucket's total with its `x/N runs` coverage, and
  `—` in the score/change columns (a lifetime total is not a run).
- Still view-only: history entries, the artifact writer, and the gate are
  untouched, so the summary cannot influence the enforced 1.0 score.

## Acceptance

- The lifetime row is present whenever history exists and sums the bucket
  columns exactly; each bucket also shows in how many runs it appeared.
- A bucket emitted only by an earlier run keeps its total and coverage after
  a later run records zero for it.
- Empty history renders the existing "no history yet" note and no footer.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx vitest run tests/unit/evals-dashboard.test.ts` → exit 0, 13 tests
  passed. New case asserts the helper's totals and per-bucket run coverage,
  the all-zero empty-history summary, and that the rendered footer carries
  `Lifetime total · 2 run(s)`, `13/14` passed, and `model-failed`'s
  `1 · 1/2 runs` coverage even though the later run recorded zero for it.
- `npm run evals:dashboard` → exit 0, 17 quality runs. The committed history
  (2 runs, both `no-evidence` 2 / `citation-invalid` 2 / `model-failed` 1 /
  `none` 2) renders one `<tfoot>` row: `14/14` passed, buckets `4, 4, 2, 4`,
  each `2/2 runs`.
- Empty history is unchanged: the panel renders the existing "no suite-run
  history recorded yet" note and no footer (covered by the existing test).
- `npm run check` → exit 0, 9/9 PASS.

## Risks

- Totals mix runs of different scenario counts: a suite that grows a scenario
  raises `none` or a bucket without any behavior change. The `x/N runs`
  coverage and the per-run columns are there to disambiguate.
- History keeps only the newest 30 runs, so lifetime means "as far back as
  the retained window", not all time.
