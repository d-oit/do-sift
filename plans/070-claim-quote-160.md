# Plan 070 — Producer quote emission for issue #160 (phase 2a: plumbing)

Status: in-progress (slice, 2026-11-27). Owner: maintainer. Follows plan 068
(phase-1 receipt: stable ids, reasons, malformed rejection).

Direction (user-chosen 2026-11-27): synthesis emits an optional verbatim
quote per claim. This slice is **plumbing only**: the contract carries
`quote` end-to-end (model response → stored blocks → claim receipt) but
nothing validates it yet. Substring validation against cited excerpts
needs passage texts at the assessment site (`runtime.answerResponse`
currently fetches only `existingIds`) — a new owner-scoped DB read, so
it stays an explicit follow-up, not silently implied.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                            | Preconditions               | Sensor  |
| ----- | --------------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| CQ-01 | Contracts: optional `quote` on `AnswerBlock`, `DraftAnswer` block, `ClaimInput`/`ClaimAssessment` echo          | Plan row exists (this file) | `tests` |
| CQ-02 | Server/storage passthrough: `AnswerBlocks.quote`, `runtime.answerResponse` forwards it; report/export unchanged | CQ-01 green                 | `tests` |
| CQ-03 | Producer enablement: JSON schema allows `quote` (strict mode), prompt invites it, `promptRevision` pr2 → pr3    | CQ-01 green                 | `tests` |
| CQ-04 | Gates: `check:fast`, `eval:offline`, signals feedback; evidence here                                            | CQ-01..03 green             | `evals` |

Out of scope: quote/span substring validation (needs passage-text
plumbing + a new DB read), `conflicting` verdicts, stale-metadata
checks, live QUAL. Fixture stays quote-less (absent is valid); report
and export schemas stay quote-less (deliberate: receipt metadata, not
report content — a separate decision if wanted).

## Decision notes

- Method: vertical-event-slice. No spike: additive optional fields,
  Zod `strict`-adjacent surfaces enumerated by search.
- `quote` bounds mirror excerpts (`min(1).max(8192)`): empty is absent,
  never a quote. `exactOptionalPropertyTypes` respected with
  conditional spreads at every hand-built literal (RET-04/SRC-06/07
  precedent).
- `additionalProperties: false` in `DRAFT_BLOCKS_JSON_SCHEMA` would
  reject producer quotes in strict mode, so the schema gains optional
  `quote` (not in `required`). `DraftAnswer.parse` then preserves it
  instead of stripping it.
- System-prompt wording change → cache discipline: `promptRevision`
  default pr2 → pr3 (`packages/server/src/answer.ts`) and live-eval
  `PROMPT_REVISION` pr2 → pr3 (`scripts/eval-live.ts`), so pre-change
  cached answers are never served as if produced under the new prompt.
- `markUnresolvedClaims` spreads blocks, so quotes survive degradation
  flagging automatically; `evidenceOnlyAnswer` stays quote-less (raw
  passages are the evidence, no producer claim to quote).
- Validation (phase 2b) will need: passage excerpts at the assessment
  site, a normalization rule (case/whitespace), and a new
  machine-readable reason (e.g. `quote-mismatch`) — none of it here.

## Evidence

- Red: new `packages/contracts/test/answer-quote.test.ts` (3 failed:
  quote stripped by Zod, empty quote accepted) + new
  `scripts/test/claims.test.ts` quote-echo case (1 failed) before the
  fix; openai-compat schema test red by construction (no `quote` key).
- Green: targeted files 31/31 PASS (4 contract + 7 claims + 20
  openai-compat response); `runtime-claims` + `answer.core` 22/22 PASS
  (fixture stays quote-less, cache tests use explicit revisions).
- `npm run check:fast` — PASS 9/9.
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; stack lines are expected
  degradation-fixture logging).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary. `quote` is
  producer-supplied data carried verbatim, never executed or rendered
  as trusted (report/export schemas deliberately exclude it);
  strict-mode schema stays closed (`additionalProperties: false`).
  Residual: quotes are UNVALIDATED — a model can quote text that is
  not in the cited passage and nothing here catches it; substring
  validation (phase 2b) needs passage-text plumbing + a new DB read
  and must land before any UI presents quotes as grounded.
