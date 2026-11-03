# Plan 020 — degradation-honesty failure suite (issue #127)

Status: done (2026-11-02). Trigger: GitHub issue #127, "Add a 'Degradation
Honesty' Test Suite for Failure Scenarios".

## Tasks

| ID     | Task                                                                                                                                                                                                | Status            | Owner | Evidence |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----- | -------- |
| DEG-01 | Add `evals/degradation/` with at least five injected-failure scenarios, run it in `npm run check`, and compute the quality gate's degradation-honesty score from the suite instead of manual labels | done (2026-11-02) | agent | below    |

## DEG-01 evidence — failure-mode suite + machine-computed score

Files:

- `evals/degradation/scenarios.json` (new) — six scenarios: search returns no
  results, search provider timeout, model synthesis failure, evidence storage
  full, citation resolution failure, cross-question evidence.
- `scripts/degradation/run.ts` (new) — injects each failure into the real path
  (in-memory libSQL, research harness, answer service, HTTP surface); asserts
  the exact user-facing message, the `answer.degraded` / `http.request`
  operational receipt, and persisted state (request status, answers stored,
  cache key, open budget reservations, retry behavior).
- `scripts/evals-degradation.ts` (new) — writes
  `evals/degradation/latest.json` with `qualityGate.degradationHonesty`.
- `tests/degradation/degradation-suite.test.ts` (new) — vitest wrapper; one
  suite run shared by the assertions.
- `scripts/eval.ts` — `evalDegradation()` computes the score from the suite,
  requires at least five scenarios, and fails the `evals` step unless every
  scenario passes (score exactly 1.0).
- `package.json` — `evals:degradation` script.
- `packages/server/src/server-contracts.ts`, `server.ts`, `metrics.ts`,
  `index.ts` — new `answer.degraded` operational receipt
  (`reason: no-evidence | citation-invalid`), exported types, and a
  `do_sift_answer_degraded_total` metric.
- `packages/server/src/default-page.ts` — the answer copy became exported
  constants (`ANSWER_EVIDENCE_ONLY_MESSAGE`, `ANSWER_GROUNDED_MESSAGE`,
  `ANSWER_FAILED_MESSAGE`, basis messages); the failure branch no longer dumps
  raw JSON into the status line. The suite asserts the shipped copy, so a page
  wording change must update the scenario expectations.
- `packages/server/test/metrics.test.ts` — counts the degraded receipt.
- `docs/quality-gate.md` — records the machine-computed score contract,
  artifact, and limits.

Contract: every scenario asserts (1) the exact page copy for the outcome,
(2) the operational receipt, and (3) persisted honesty — failed requests stay
failed, no answer is fabricated on failure, degraded answers are not cached,
and no budget reservation stays open. Score = passed scenarios / registered
scenarios; an empty suite throws (INV-006 spirit).

Commands / results (2026-11-02, repo root):

- `npm run check` → exit 0, **9/9 PASS**: prettier 4939ms, eslint 3443ms,
  typecheck 1248ms, policy 243ms, skills 216ms, governance 226ms, tests
  7701ms, evals 35391ms, build 2301ms (full mode; the `evals` step now runs
  the degradation suite).
- `npx vitest run tests/degradation/degradation-suite.test.ts
packages/server/test/metrics.test.ts packages/server/test/server.answer.test.ts`
  → exit 0, **3 files / 18 tests pass**.
- `npm run evals:degradation` → exit 0, `6/6 scenarios passed;
degradationHonesty=1.000`; artifact `evals/degradation/latest.json`.
- `npx tsc -p tsconfig.json --noEmit` → exit 0.

Red → green notes: the first suite run exposed two expectation defects, not
production defects — the fake model records no call when it throws before
returning (model-failure expectation corrected to 0 recorded calls), and the
citation-failure page copy includes the run-basis sentence (expected message
corrected). No production check was weakened.

Risks / open questions:

- Constructed corpus + fake providers: the score measures harness honesty
  behavior, not a live provider outage; live QUAL runs still score real
  degradations per the manual protocol.
- Model synthesis failure keeps the existing fail-closed contract (request
  failed, `500`, no fabricated answer) rather than the issue's proposed
  evidence-only fallback; `packages/server/test/answer.core.test.ts` pins that
  behavior. A fallback would be a product change with budget/cache semantics
  to define.
- Citation failure degrades the whole answer to self-citing stored passages;
  per-claim "unresolved" flags are not implemented in the ANS-03 design
  ("no repair loop"). Recorded as a residual product decision.
- `plans/invariants.json` was deliberately not edited (approval boundary); the
  suite is enforced by `scripts/eval.ts` under the existing `evals` gate
  rather than a new invariant row.

## Follow-up (2026-11-02)

The two residuals above were implemented the same day in
`plans/021-degradation-behavior.md`: model-provider failure now falls back to
evidence-only output, and citation validation is per claim with an
`unresolved` flag. This plan's scenario set grew to seven and pins the new
behavior; the earlier fail-closed expectations are superseded.

## Handoff

- **Task:** DEG-01 — done.
- **Files:** listed above.
- **Commands:** `npm run check` 9/9 PASS; focused vitest 18/18; artifact CLI
  exit 0 at score 1.000; `tsc --noEmit` exit 0.
- **Risks:** documented above (fake-provider scope, fail-closed model path,
  no per-claim unresolved status).
- **Next suggested task:** decide whether model-provider failure should
  degrade to evidence-only (product change), or leave fail-closed as designed.
