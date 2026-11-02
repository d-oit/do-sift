# 023 — Degradation reason coverage on failure (DEG-06)

Status: done (2026-11-02). Follow-up to plans 019/021/022 (issue #127).

## Goal

A failed suite run could lose a reason bucket without saying so. The history
trend counted expected reasons, so a run whose `model-failed` receipt vanished
looked identical to a healthy one, and the failure output listed checks
without naming the bucket. Report each bucket's expected-vs-emitted count on
failure, and score the trend from emitted receipts.

## Task table

| ID | Task | Status |
| ------ | -------------------------------------------------------- | ----------- || DEG-06 | Report missing reason buckets and count emitted receipts | done |

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

## Risks

- Coverage compares the pinned suite's expectations with one run's events; it
  is a fixture diagnostic, not a production incidence measure.
- Rows recorded before this change counted expectations; with matching
  receipts the numbers are identical, but a future failing run is the first
  place the two definitions would diverge.
- Both committed history rows come from regression runs on the same day, so
  the trend demonstrates plumbing, not behavior change over time.
