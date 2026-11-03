# 027 — Weight bucket coverage by run recency (DEG-10)

Status: done (2026-11-02). Follow-up to plan 026 (issue #127).

## Goal

Plan 026 compared each bucket's run coverage across a fixed midpoint split, so
a bucket that recovered in the newest runs could still be flagged: the older
bulk of the history outvoted it. Keep the coverage comparison, but let the
newer runs decide where the boundary sits.

## Task table

| ID     | Task                                      | Status |
| ------ | ----------------------------------------- | ------ |
| DEG-10 | Weight the coverage comparison by recency | done   |

## Approach

- `scripts/evals-dashboard.ts`: `recentCoverageSplit(runCount)` returns the
  index where the recent window starts — the shortest suffix of newest runs
  holding at least half of the history's weight, leaving one run on each side.
  Each older run keeps `COVERAGE_RECENCY_DECAY` (0.9) of the weight of the run
  recorded after it, so the split is the weight median rather than the index
  median.
- `describeShrinkingCoverage` uses that split and keeps the previous
  comparison: per-bucket fraction of runs that emitted it, flagged only when
  the newer fraction is lower (integer cross-multiplication, no float compare).
- Displayed counts stay run counts, but the windows are no longer halves: a
  two-run history still splits 1/1, a four-run history 2/2, and a full 30-run
  history compares its newest 7 runs against the 23 before them.
- View-only: history entries, the artifact writer, and the enforced 1.0 gate
  score are unchanged.

## Acceptance

- A bucket that recovered in the newest runs is not flagged where the fixed
  midpoint split would have flagged it.
- A bucket emitted in every run before the split and in none after it is still
  flagged with its before/after coverage.
- Flat coverage, growing coverage, and fewer than two runs produce no warning.
- The flag is derived from emitted receipts, never from expectations.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx vitest run tests/unit/evals-dashboard.test.ts` → exit 0, 15 tests
  passed. New case pins `recentCoverageSplit` (1 → 1, 2 → 1, 4 → 2, 10 → 6,
  30 → 23) and a 30-run history with ten early emissions, thirteen misses and
  seven newest emissions that is flagged by a midpoint split but not here.
- `npm run evals:dashboard` → exit 0; the committed two-run history is stable,
  so the real artifact contains no warning.
- `npm run check` → exit 0, 9/9 PASS.

## Risks

- The 0.9 decay is a judgement call: sharper decay (0.75) pins the recent
  window near three runs whatever the history length and turns single runs
  into noise; flatter decay drifts back toward the midpoint.
- The recent window saturates around seven runs once the history is long, so
  the comparison never shrinks to a single run, but it also no longer grows.
- The per-run columns and deltas remain the authoritative detail; this note is
  a summary flag, not a gate.
