# 030 — Exercise evidence storage failure in the degradation suite (DEG-13)

Status: done (2026-11-02). Follow-up to plans 020/021 and issue #127.

## Goal

Issue #127 lists "evidence storage full" as a failure mode the suite must
cover. The scenario registered under that name was failing `answers.insert` —
the answer write, not the evidence write — so a rejection of stored evidence was
never exercised. Cover both writes under names that say which one failed, and
pin what the engine claims when evidence it fetched cannot be stored.

## Task table

| ID     | Task                                                           | Status |
| ------ | -------------------------------------------------------------- | ------ |
| DEG-13 | Add an evidence-storage failure scenario beside the answer one | done   |

## Approach

- `evals/degradation/scenarios.json`: the scenario that fails `answers.insert`
  becomes `answer-storage-full` (name, id and expectations unchanged). A new
  `evidence-storage-full` scenario injects `evidence-failure`, runs research
  against a storage layer whose `documents.insert` throws `SQLITE_FULL`, and
  expects the honest outcome: the run reports one failed fetch and stores no
  source, then the answer degrades to evidence-only with a `no-evidence`
  receipt, zero model calls and no cache key of its own.
- `scripts/degradation/run.ts`: the `Injection` union and `INJECTIONS` list gain
  `evidence-failure`; `failingEvidenceStorage()` patches `documents.insert` the
  same way `failingAnswerStorage()` patches `answers.insert`. The research phase
  gains a `storage-full` mode that asserts `documentsStored`,
  `passagesStored` are `0`, the `done` receipt counts exactly one
  `fetchErrors`, and no `documents` row reached the database.
- The harness stores evidence per source inside a `try`, so a storage rejection
  is a failed fetch rather than a thrown run; the scenario records that
  behavior instead of assuming a 500.

## Acceptance

- `evidence-storage-full` fails the document write, stores nothing, reports one
  failed fetch, and the answer says it has no evidence.
- `answer-storage-full` still pins the `500`, the failed request and the
  "Answer failed" message.
- The suite registers at least five scenarios and every expectation holds.
- `npm run check` stays green.

## Evidence

Commands run 2026-11-02 from the repo root:

- Red before green: the dataset gained the scenario before the runner knew the
  injection; `npx vitest run tests/degradation/degradation-suite.test.ts` → exit
  1, `4 skipped (4)` — `runDegradationSuite()` in `beforeAll` rejected the
  unknown injection, so the suite failed closed instead of silently running
  seven scenarios.
- `npx vitest run tests/degradation/degradation-suite.test.ts` after the change
  → exit 0, 4 tests passed (eight scenario ids, eight expected receipts).
- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npm run evals:degradation` → 8/8 scenarios passed,
  `degradationHonesty=1.000`; `evals/degradation/latest.json` lists the new
  scenario.
- `npm run evals:dashboard` → exit 0; panel shows eight scenario rows.
- `npm run check` → exit 0, 9/9 PASS.

## Risks

- Scenario ids are part of the artifact: a consumer keyed on the old
  `evidence-storage-full` id now sees `answer-storage-full` plus a genuinely
  different `evidence-storage-full`.
- The scenario pins the current contract — a storage rejection is swallowed
  per source and surfaces as `fetchErrors: 1` with a `200` research response.
  Turning storage errors into hard failures would be a deliberate change with
  this expectation updated alongside it.
- Still offline and in-memory: a fake `SQLITE_FULL`, not a real full disk.
