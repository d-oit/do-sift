# 029 — Require rising receipts before calling coverage a recovery (DEG-12)

Status: done (2026-11-02). Follow-up to plans 026, 027 and 028 (issue #127).

## Goal

Plan 028 reports a bucket as "Coverage growing" whenever its share of runs rose
across the recency-weighted split. Share alone can rise for a reason that is not
a recovery: the recent window holds fewer runs, so a bucket can cover every
recent run while the suite emits fewer of its receipts than before — which is
what happens when a scenario is added late in the suite's life. Require the
receipt total to rise as well, so a wider share with less evidence stays quiet.

## Task table

| ID     | Task                                                       | Status |
| ------ | ---------------------------------------------------------- | ------ |
| DEG-12 | Gate the growing note on the bucket's receipt total rising | done   |

## Approach

- `BucketCoverageShift` carries `earlierReceipts` and `recentReceipts` — the
  receipts the two windows emitted for the bucket (sum of
  `entry.reasons[bucket]`), alongside the existing run-coverage fields.
- `describeCoverageShifts` still treats a strictly larger share as growth, but
  reports it only when `recentReceipts > earlierReceipts`. A bucket whose share
  rose while receipts fell or held produces no entry at all, rather than a
  softer note: coverage moved, evidence did not.
- The shrinking side is unchanged — a bucket that covers fewer runs is still
  called out even when its receipt total happened to rise.
- Rendering, `recentCoverageSplit`, the history schema/writer, and the enforced
  1.0 gate score are untouched.

## Acceptance

- Growth is reported only when the share rose **and** the receipt total rose.
- A bucket whose share rose while its receipts fell is not reported.
- Shrinking coverage is still reported with its receipt totals.
- Equal coverage and fewer than two runs still produce no note.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npm ci` → exit 0 (the restored sandbox had no `node_modules`; lockfile
  preserved, no dependency changes).
- Red before green: `npx vitest run tests/unit/evals-dashboard.test.ts` with the
  new expectations against the plan-028 implementation → exit 1, 4 failed / 13
  passed: the two existing shift tests failed for the missing
  `earlierReceipts`/`recentReceipts` fields, and both receipt cases reported
  `[{ bucket: 'model-failed', … }]` where `[]` was expected.
- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx vitest run tests/unit/evals-dashboard.test.ts` after the change → exit 0,
  17 tests passed. The new case pins a widened share with a falling receipt
  total (`2/6 → 4/4 runs`, `10 → 4` receipts) as unremarkable, then the same
  history emitting `12` recent receipts as `direction: "growing"` with both
  windows' totals.
- `npm run evals:dashboard` → exit 0; the committed two-run history is flat per
  bucket, so the artifact gains no note.
- `npm run check` → exit 0, 9/9 PASS.

## Risks

- The receipt rule is a high bar on long histories: the recency split weighs
  roughly 7 recent runs against 23 earlier ones, so a bucket must emit more
  receipts inside that smaller window. The 30-run case from plan 027 no longer
  shows a note (`10/23 → 7/7 runs` with `10 → 7` receipts) and is pinned that
  way deliberately.
- Absolute totals compare unequal windows; a per-run receipt rate would be the
  gentler rule if the note proves too quiet in practice.
- More receipts of a failure bucket is worse news, not better: the note reports
  that the suite surfaces the reason more, not that quality improved.
