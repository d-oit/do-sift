# 028 — Note recovered bucket coverage as well as lost coverage (DEG-11)

Status: done (2026-11-02). Follow-up to plans 026 and 027 (issue #127).

## Goal

Plans 026 and 027 only call out a reason bucket whose share of runs fell, so a
receipt that came back across the same comparison stayed invisible: the panel
said nothing when coverage recovered. Report both directions from the one
coverage comparison, so a recovery is as visible as a regression.

## Task table

| ID     | Task                                               | Status |
| ------ | -------------------------------------------------- | ------ |
| DEG-11 | Note buckets whose coverage grew as well as shrank | done   |

## Approach

- `scripts/evals-dashboard.ts`: `describeShrinkingCoverage` becomes
  `describeCoverageShifts`, returning every bucket whose coverage moved across
  the recency-weighted split with a `direction` of `"growing"` or
  `"shrinking"`. Equal coverage yields no entry, and the two fractions are
  still compared by integer cross-multiplication.
- `BucketCoverageShift` gains `direction`; the window fields
  (`earlierRuns`, `earlierWithBucket`, `recentRuns`, `recentWithBucket`) are
  unchanged, so the note keeps showing real run counts.
- Rendering: one note above the table, grouped by direction — the existing
  `Coverage shrinking` pill (`score-partial`) and a `Coverage growing` pill
  (`score-pass`), each followed by its `X/Y → A/B runs` entries.
- View-only: history entries, the artifact writer, `recentCoverageSplit`, and
  the enforced 1.0 gate score are untouched.

## Acceptance

- A bucket emitted in none of the earlier runs and in every recent run is
  reported as growing with its before/after coverage.
- A bucket emitted in every earlier run and in none of the recent runs is still
  reported as shrinking.
- Flat coverage and fewer than two runs produce no note.
- The note is derived from emitted receipts, never from expectations.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- Red before green: `npx vitest run tests/unit/evals-dashboard.test.ts` before
  the implementation → exit 1, 3 failed / 13 passed, each failure
  `TypeError: describeCoverageShifts is not a function`.
- `npx vitest run tests/unit/evals-dashboard.test.ts` after the change → exit
  0, 16 tests passed. The new case pins a growing shift
  (`0/2 → 2/2 runs`, `direction: "growing"`, `Coverage growing` pill, no
  shrinking pill); the shrinking case now asserts `direction: "shrinking"`
  and that flat coverage is not noted; the 30-run recency case now expects the
  recovered `model-failed` bucket as growing (`10/23 → 7/7 runs`).
- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npm run evals:dashboard` → exit 0; the committed two-run history is
  identical, so neither note appears in the real artifact.
- `npm run check` → exit 0, 9/9 PASS.

## Risks

- The panel now carries two kinds of note; a history where buckets churn every
  run prints both groups. The per-run columns and deltas remain the
  authoritative detail, and nothing here feeds the gate.
- Growth is only compared on the same windows as shrinkage, so a recovery that
  stays below the earlier share (for example 10/23 → 5/7) is still reported as
  shrinking even though the newest runs emit it.
- The note names trends, not causes: a bucket that grows because a scenario was
  added looks the same as one recovering from a real failure.
