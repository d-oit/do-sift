# Plan 020 — honest-degradation behavior (issue #127 follow-ups)

Status: done (2026-11-02). Trigger: issue #127's failure-mode contract, after
plan 019 shipped the suite and recorded two residual product gaps.

## Tasks

| ID     | Task                                                                                                                                                                                  | Status            | Owner | Evidence |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----- | -------- |
| DEG-02 | Model provider failure falls back to evidence-only output (200, stored evidence, no cache, no fabricated claims) instead of failing the request with a 500                            | done (2026-11-02) | agent | below    |
| DEG-03 | Citation validation is per claim: resolved claims stay grounded, unresolved claims are flagged (`unresolved: true`) and labeled in the page; all-unresolved degrades to evidence-only | done (2026-11-02) | agent | below    |

## DEG-02 / DEG-03 evidence

Behavior:

- `packages/server/src/answer.ts` catches a model-call failure (not
  cancellation) and answers from the packed evidence via
  `evidenceOnlyAnswer`, completing the request, settling the reservation with
  zeros, storing no usage, and omitting the cache key.
- `packages/server/src/answer-evidence.ts` adds `markUnresolvedClaims`: it
  filters citations to stored ids, flags a claim when any citation is unknown
  or absent, and returns the surviving-claim count. `answer.ts` keeps marked
  blocks when at least one claim survives; otherwise it degrades to
  evidence-only (no repair loop).
- `AnswerOutcome` / `AnswerHttpResponse` carry
  `degradationReason: "no-evidence" | "citation-invalid" | "model-failed"`;
  `answer.degraded` uses the service's reason (block-count fallback retained
  for older payload producers).
- Contracts and storage accept `unresolved?: boolean` on answer blocks; the
  bundled page renders `ANSWER_PARTIAL_MESSAGE` and
  `ANSWER_UNRESOLVED_LABEL` and never presents an unresolved claim as
  grounded.
- `FakeModelProvider` gains `partial-hallucinate` (first claim grounded, rest
  fabricated) and now records a call before a `failWith` throw, so call
  counts describe attempts.

Checks (2026-11-02, repo root):

- `npm run check` → exit 0, **9/9 PASS** (prettier, eslint, typecheck, policy,
  skills, governance, tests 6094ms, evals 5887ms, build).
- `npx vitest run packages/server/test/answer.core.test.ts
packages/server/test/server.answer.test.ts packages/server/test/metrics.test.ts
tests/degradation/degradation-suite.test.ts` → exit 0, **38 tests pass**.
- `npm run evals:degradation` → exit 0, **7/7 scenarios**, score 1.000.
- `npx tsc -p tsconfig.json --noEmit` → exit 0.

Risks / open questions:

- A failed model call is settled at zero actual usage because the provider
  reported none; the reservation is closed, never left open.
- Partial answers are not cached (cacheKey omitted), so identical questions
  retry the model — consistent with the existing degraded-cache rule.
- Live eval (`scripts/eval-live.ts`) still simulates citation validation
  itself; its abstention score now keys on `degraded`, but it does not model
  per-claim partials. It is not part of CI.

## Handoff

- **Task:** DEG-02 and DEG-03 — done.
- **Files:** `scripts/degradation/run.ts`, `evals/degradation/scenarios.json`,
  `packages/server/src/{answer,answer-contracts,answer-evidence,server,server-contracts,runtime,metrics,default-page,index}.ts`,
  `packages/contracts/src/evidence.ts`, `packages/storage/src/rows.ts`,
  `packages/fake-providers/src/fake-providers.ts`, tests, docs, plan 019.
- **Commands:** recorded in the final handoff message.
- **Risks:** listed above.
- **Next suggested task:** expose `degradationReason` breakdown in the evals
  dashboard so partial-vs-all-unresolved trends are visible.
