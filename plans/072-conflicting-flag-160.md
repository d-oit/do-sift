# Plan 072 — Producer-flagged conflicting evidence for issue #160

Status: done (slice, 2026-11-27). Owner: maintainer. Follows plan 071
(phase-2b quote validation: normalized substring, `quote-mismatch`).

Direction (user-chosen 2026-11-27, "Conflicting verdicts"): surface cited-source
disagreement without claiming entailment. There is no deterministic semantic
conflict detector (existence is not entailment, ADR 0003/0004), so this slice
does NOT add NLI. It adds a producer honesty flag: when the model sees its
cited passages disagree (e.g. live-case-06 b=0.75 vs 0.5), it sets
`conflicting: true` on that block; the receipt degrades honestly.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                                              | Preconditions   | Sensor  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------- |
| CF-01 | Contracts: `conflicting` on `AnswerBlock`/`DraftAnswer` block/`AnswerBlocks`/`ClaimInput`, echo + `upstream-conflict-flag` reason | Plan row exists | `tests` |
| CF-02 | Server/runtime/schema passthrough + prompt invite + `promptRevision` pr3 → pr4 (cache discipline)                                 | CF-01 green     | `tests` |
| CF-03 | Gates: `check:fast`, `eval:offline`, signals feedback; evidence here                                                              | CF-01..02 green | `evals` |

Out of scope: semantic conflict detection (no NLI, no second synthesis call),
stale-metadata checks, live QUAL, report/export surfacing (receipt metadata,
not report content — same boundary as quotes in plans 070/071).

## Decision notes

- Method: vertical-event-slice. No spike: additive optional boolean, mirrors
  the `unresolved` honesty-flag plumbing (plan 068) and `quote` plumbing
  (plan 070).
- Semantics: `conflicting: true` means "my cited passages disagree, so this
  claim is disputed even though every citation exists". Absent/false = no
  signal (backward compat). Never inferred by the system — only the producer
  (which saw the passage texts) can assert it.
- Support: `partially-supported`, uncertainty `partial` — the claim cites
  real evidence but the evidence basis is disputed. Same level as
  `quote-mismatch` and `upstream-unresolved-flag`.
- Precedence (deterministic, single reason): `no-citations` >
  `malformed-citations` > `no-citations-resolve` > `some-citations-missing` >
  `quote-mismatch` > `upstream-conflict-flag` > `upstream-unresolved-flag` >
  `all-citations-resolve`. Structural missing beats content disputes;
  system-validated `quote-mismatch` beats producer flags; conflict (specific)
  beats generic unresolved.
- `markUnresolvedClaims` spreads blocks, so `conflicting` survives
  citation-invalid degradation automatically; `evidenceOnlyAnswer` stays
  flag-less (raw passages are the evidence, no producer dispute to carry).
- Cache discipline: system-prompt wording change → `promptRevision` default
  pr3 → pr4 (`packages/server/src/answer.ts`) and live-eval `PROMPT_REVISION`
  pr3 → pr4 (`scripts/eval-live.ts`), so pre-change cached answers are never
  served as if produced under the new prompt (D5).
- `exactOptionalPropertyTypes` respected with conditional spreads
  (RET-04/SRC-06/07 precedent).

## Evidence

- Red: new `scripts/test/claims.test.ts` conflict cases (flag +
  precedence) failed before the fix (`reason` stayed
  `all-citations-resolve`); new runtime conflict case failed before
  wiring (`support` stayed `supported`); contract `conflicting` parse
  cases failed before the Zod fields (stripped); schema `conflicting`
  guard failed before the schema key.
- Green: `scripts/test/claims.test.ts` — PASS 11/11 (2 new conflict
  cases); `packages/contracts/test/answer-quote.test.ts` — PASS 5/5
  (1 new conflict case); `packages/server/test/runtime-claims.test.ts` —
  PASS 5/5 (1 new conflict wiring case);
  `packages/plugins/plugin-model-openai-compat/test/openai-compat.response.test.ts` —
  PASS 22/22 (1 new schema guard).
- `npm run check:fast` — PASS 9/9.
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; stack lines in output are expected
  degradation-fixture logging).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary. `conflicting` is a
  producer-supplied honesty flag carried verbatim, never executed or
  inferred; no NLI, no second synthesis call, no new DB reads;
  report/export schemas stay flag-less (receipt metadata, not report
  content). Residual: `supported` remains structural + verbatim-span
  only, never entailment; semantic conflict detection stays out of
  scope (no deterministic detector).
