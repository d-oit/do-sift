# 034 — Highlight trend rows whose reason buckets moved (DEG-07)

Status: done (2026-11-02). Follow-up to plans 022/023 (issue #127).
Renumbered from 024 on 2026-11-03: `024-multi-tenant-auth.md` (issue #120)
already held that number and is cited as "plan 024" throughout `packages/`,
`apps/`, `migrations/` and `docs/`. Only this file's number changed; task ID
`DEG-07` is stable.

## Goal

The trend table lists per-run reason counts, so a changed bucket has to be
found by subtracting columns by eye. Highlight a run whose bucket counts
differ from the previous run and state the per-bucket delta, so a lost or
shifted receipt is visible in the table itself rather than only in a failing
run's console output.

## Task table

| ID | Task | Status |
| ------ | ---------------------------------------------- | ----------- || DEG-07 | Highlight changed reason buckets per trend row | done |

## Approach

- `scripts/evals-dashboard.ts`: `describeReasonChanges(current, previous)`
  compares emitted receipt counts per bucket and returns `null` when nothing
  moved, else a compact delta string (`model-failed -1, none +1`).
- Each history row gains a "Change vs previous" cell: `—` for the first
  recorded run, `unchanged` when stable, the delta string otherwise. Changed
  rows also carry `class="bucket-changed"`, highlighted in amber — styled on
  non-score cells so the pass/fail score colour is not painted over.
- The comparison is view-only: history entries, the gate, and the artifact
  writer are unchanged.

## Acceptance

- A row whose bucket counts differ from the previous row is highlighted and
  names each moved bucket with a signed delta.
- A row identical to its predecessor is not highlighted and reads
  `unchanged`; the first recorded run reads `—`.
- Deltas compare emitted receipts, so no expectation is restated.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx vitest run tests/unit/evals-dashboard.test.ts` → exit 0, 12 tests
  passed. New case asserts `describeReasonChanges` returns null for a stable
  pair and `model-failed -1, none +1` for the changed pair, and that building
  the dashboard highlights exactly one row (`<tr class="bucket-changed">`),
  while the first run shows the `first recorded run` marker.
- `npm run evals:dashboard` → exit 0, 17 quality runs. The committed history
  holds two identical runs, so the real artifact correctly highlights zero
  rows and shows `Change vs previous` with `—` / `unchanged`.
- Temporary, uncommitted demo: appended a copy of the newest history row with
  `model-failed` 0 / `none` 3, regenerated, and found exactly one highlighted
  row reading `class="bucket-delta" title="changed since 2026-11-02">model-failed -1, none +1`.
  `git checkout -- evals/degradation/history.json` then restored the file and
  regeneration showed zero highlighted rows again.
- `npm run check` → exit 0, 9/9 PASS.

## Renumbering

2026-11-03, from the multi-tenant branch where the collision was noticed. The
file moved from `024-degradation-trend-deltas.md` to
`034-degradation-trend-deltas.md` (next free number after `033`); the title
and the `plans/README.md` queue entry follow it. Task table, evidence and risks
below are unchanged.

Commands run from the repo root:

- `git mv plans/024-degradation-trend-deltas.md plans/034-degradation-trend-deltas.md`
  → exit 0; `ls plans | grep 024` now lists only `024-multi-tenant-auth.md`.
- `rg -n 'plans/024|024-degradation|trend-deltas'` before the move found two
  references only: this plan's own heading and one `plans/README.md` line. The
  code-side "plan 024" comments all name the auth plan, so no source file
  referenced this one.
- `npm run check:fast` → exit 0 after the edits.

## Risks

- The highlight marks movement, not health: a bucket can move in either
  direction, and the score column still carries the pass/fail judgement.
- Runs recorded before history counted receipts are compared on the same
  basis, so a definitional change would look like a bucket move.
