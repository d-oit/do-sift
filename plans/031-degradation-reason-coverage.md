# 031 — Degradation reason coverage on failure (DEG-06)

Status: done (2026-11-02). Follow-up to plans 020/022/023 (issue #127).
Renumbered from 023 to 031 when the #130/#131 merge kept main's canonical
019–023 numbering for the guardrails and degradation plans.

## Goal

A failed suite run could lose a reason bucket without saying so. The history
trend counted expected reasons, so a run whose `model-failed` receipt vanished
looked identical to a healthy one, and the failure output listed checks
without naming the bucket. Report each bucket's expected-vs-emitted count on
failure, and score the trend from emitted receipts.

## Task table

| ID | Task | Status |

| ID     | Task                                                     | Status |
| ------ | -------------------------------------------------------- | ------ |
| DEG-06 | Report missing reason buckets and count emitted receipts | done   |

## Approach

- `scripts/degradation/run.ts`: each scenario result carries `receiptReason` —
  the `answer.degraded` reason the run actually emitted, or `null`. It is
  evidence from the event stream, not a restatement of the expectation.
- `scripts/degradation/history.ts`: `countDegradationReceipts()` and
  `computeReasonCoverage()` compare expected vs emitted counts;
  `describeReasonCoverage()` prints one line per mismatched bucket
  (`missing N` / `unexpected +N`) or a single all-match line.
- `scripts/evals-degradation.ts` and `scripts/eval.ts`: a failing run prints
  the coverage lines after the per-check failures, so `npm run check` names
  the bucket that went missing.
- `scripts/evals-dashboard.ts`: history entries store emitted receipts (not
  expectations), and the trend table says so; a failed run therefore shows a
  count dropping instead of copying the expected composition.

## Acceptance

- A run with a missing receipt names that bucket and its count delta.
- History `reasons` are emitted receipts; a failed scenario cannot contribute
  an unobserved count.
- Passing runs still show full coverage (`reason buckets match: ...`).
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- `npx tsc -p tsconfig.json --noEmit` → exit 0. First attempt caught the
  `receiptReason` capture declared inside `try` and unused at the return
  (`TS2552`); fixed by hoisting it and assigning inside the run.
- `npx vitest run tests/unit/degradation-history.test.ts tests/degradation/degradation-suite.test.ts tests/unit/evals-dashboard.test.ts`
  → exit 0, 3 files / 25 tests passed. New assertions cover missing/extra
  bucket lines and the per-scenario `receiptReason` sequence
  (`no-evidence`, `no-evidence`, `model-failed`, null, `citation-invalid`,
  `citation-invalid`, null).
- `npm run evals:degradation` → 7/7, degradationHonesty=1.000; history grew
  to 2 recorded runs, both counting emitted receipts (2 no-evidence,
  2 citation-invalid, 1 model-failed, 2 none).
- `npm run evals:dashboard` → exit 0, 17 quality runs, trend table rendered.
- `npm run check` → exit 0, 9/9 PASS.

### End-to-end failure-path proof (temporary fixture, not committed)

To show the diagnostic fires on a real regression and not only on unit
fixtures, `scripts/degradation/run.ts` was temporarily patched to drop the
`answer.degraded` event for `model-synthesis-failure` (an emitter that stops
publishing that receipt), then reverted with
`git checkout -- scripts/degradation/run.ts evals/degradation`. Nothing from
the fixture is committed; `git status --short` was empty afterwards.

With the fixture in place, `npm run evals:degradation` exited 1 with
`6/7 scenarios passed; degradationHonesty=0.857` and printed:

- `FAIL model-synthesis-failure / answer.degraded receipt: expected`
  `{"type":"answer.degraded","reason":"model-failed"}, got none`
- `reason coverage (expected vs emitted receipts):`
- `model-failed: expected 1, observed 0 (missing 1)`
- `none: expected 2, observed 3 (unexpected +1)`

`npm run check` exited 1 with 8/9 steps: `tests` and `evals` both red. The
same bucket is named by the gate assertion
(`degradation reason buckets cover registered scenarios — model-failed:
expected 1, observed 0 (missing 1); none: expected 2, observed 3 (unexpected
+1)`) and by the suite test whose `receiptReason` sequence lost
`model-failed`. The diagnostics are therefore enforced twice, not just
printed.

After restore: `npm run check` → exit 0, 9/9 PASS; `git status --short`
empty; `evals/degradation/history.json` back to its 2 committed runs (the
broken run's row was written, then discarded with the artifact restore).
`node_modules` was absent in this VM at the start of the check, so `npm ci`
restored it from the committed lockfile — no dependency or lockfile changes.

## Risks

- Coverage compares the pinned suite's expectations with one run's events; it
  is a fixture diagnostic, not a production incidence measure.
- Rows recorded before this change counted expectations; with matching
  receipts the numbers are identical, but a future failing run is the first
  place the two definitions would diverge.
- Both committed history rows come from regression runs on the same day, so
  the trend demonstrates plumbing, not behavior change over time.
