# 026 — Flag shrinking reason-bucket coverage (DEG-09)

Status: done (2026-11-02). Follow-up to plans 022–025 (issue #127).

## Goal

Lifetime totals say how much each bucket emitted, and deltas say what moved
between adjacent runs, but neither names the regression-shaped pattern: a
receipt that used to fire in every run and now fires in none. Add a warning
that compares a bucket's run coverage in the earlier half of the recorded
history with the newer half.

## Task table

| ID | Task | Status |
| ------ | -------------------------------------------- | ----------- || DEG-09 | Flag buckets whose run coverage is shrinking | done |

## Approach

- `scripts/evals-dashboard.ts`: `describeShrinkingCoverage(history)` splits
  the history at the midpoint and compares, per bucket, the fraction of runs
  that emitted it. It returns the shifts where the newer fraction is lower.
  With fewer than two runs there are no halves, so nothing is flagged.
- Fractions rather than raw counts: the halves can differ in size, and a
  bucket that only gained coverage is never reported.
- Rendering: a "Coverage shrinking" pill plus one `X/Y → A/B runs` line per
  flagged bucket, placed above the trend table. Styled with the existing
  `reason-pill score-partial` classes and a flex `.coverage-warning` rule.
- View-only: history entries, the artifact writer, and the enforced 1.0 gate
  score are unchanged.

## Acceptance

- A bucket emitted in every earlier run and in none of the newer runs is
  flagged with its before/after coverage.
- Flat coverage, growing coverage, and fewer than two runs produce no warning.
- The flag is derived from emitted receipts, never from expectations.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx vitest run tests/unit/evals-dashboard.test.ts` → exit 0, 14 tests
  passed. New case pins the flagged shift (`model-failed`, 2/2 → 0/2), that a
  single run, flat coverage, and growing coverage yield no shifts, that the
  warning renders `2/2 &rarr; 0/2 runs` with the `Coverage shrinking` pill,
  and that a stable history renders no warning.
- `npm run evals:dashboard` → exit 0. The committed two-run history is
  stable, so the real artifact correctly contains no warning.
- Temporary, uncommitted demo: appended two copies of the newest history row
  with `model-failed` 0 / `none` 4 (four runs: 2 with the bucket, 2 without),
  regenerated, and found exactly one `Coverage shrinking` block. After
  `git checkout -- evals/degradation/history.json` and regeneration the
  warning count was back to 0.
- `npm run check` → exit 0, 9/9 PASS.

## Risks

- Splitting at the midpoint is a crude trend: an oscillating bucket can be
  flagged on a half-to-half comparison even though the newest run recovered.
  The per-run columns and deltas remain the authoritative detail.
- Half-sizes of one run make the comparison noisy (2/2 → 0/1 is a real
  warning but rests on a single newer run); history is retained at 30 runs so
  the halves grow with use.
