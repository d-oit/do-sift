# 022 — Degradation-suite run history (DEG-05)

Status: done (2026-11-02). Follow-up to plans 019/021 (issue #127).

## Goal

`evals/degradation/latest.json` records one suite snapshot, so the dashboard
could only show the current reason mix. Record each suite run and render the
reason counts across runs, so a growing reason bucket is visible without
having to remember prior output.

## Task table

| ID     | Task                                                        | Status |
| ------ | ----------------------------------------------------------- | ------ |
| DEG-05 | Append suite runs to history and trend reasons in dashboard | done   |

## Approach

- `scripts/degradation/history.ts` owns the history contract: reason buckets
  (`no-evidence`, `citation-invalid`, `model-failed`, `none`), a compact
  entry per run, an append that trims to the newest 30 runs, and a loader
  that tolerates a missing or corrupt file (trend is evidence, not a gate).
- `scripts/evals-degradation.ts` stamps `executedAtUtc`, writes
  `latest.json` unchanged in shape (plus the timestamp), then appends one
  history entry to `evals/degradation/history.json`.
- `scripts/evals-dashboard.ts` loads the history and renders "Reason Counts
  Across Suite Runs" under the degradation panel: one row per run with score,
  pass counts, and each reason bucket. A single recorded run is labeled as
  the start of the trend rather than presented as one.
- `npm run check` is untouched: `scripts/eval.ts` still computes the current
  run's score in memory and enforces 1.0, so history cannot affect the gate.

## Acceptance

- Running `npm run evals:degradation` appends one entry and keeps history
  ascending by timestamp, capped at the newest 30 runs.
- Dashboard shows the trend table with per-run reason counts and marks the
  latest run.
- Missing/corrupt history degrades to an explicit note, not a crash, and the
  existing panel still renders.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npx vitest run tests/unit/degradation-history.test.ts tests/unit/evals-dashboard.test.ts`
  → exit 0, 2 files / 17 tests passed.
- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npm run evals:degradation` → 7/7 scenarios, degradationHonesty=1.000;
  wrote `latest.json` (now stamped `executedAtUtc`) and `history.json`
  (1 recorded run: 2 no-evidence, 2 citation-invalid, 1 model-failed,
  2 none).
- `npm run evals:dashboard` → exit 0, 17 quality runs; generated
  `evals/dashboard/index.html` contains "Reason Counts Across Suite Runs"
  and "Latest artifact: 2026-11-02".
- `npm run check` → exit 0, 9/9 PASS (prettier, eslint, typecheck, policy,
  skills, governance, tests, evals, build).

## Risks

- Committed history entries carry wall-clock timestamps, so regenerating the
  artifact always produces a diff; the cap bounds growth but does not make
  the file stable.
- History records the pinned seven-scenario suite. Reason counts describe
  fixture composition, not production incidence, and a scenario added in a
  later suite version makes adjacent rows incomparable.
- The committed history holds one run, so the dashboard states that this is
  the first recorded row; the multi-run trend rendering is covered by the
  unit fixtures, not by the committed artifact.
