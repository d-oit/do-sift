# Plan 071 — Quote substring validation for issue #160 (phase 2b)

Status: in-progress (slice, 2026-11-27). Owner: maintainer. Follows plan 070
(phase-2a plumbing: `quote` carried end-to-end, never validated).

Direction (user-chosen 2026-11-27, "do next"): validate producer quotes
against cited excerpts before any UI presents quotes as grounded.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                  | Preconditions   | Sensor  |
| ----- | ----------------------------------------------------------------------------------------------------- | --------------- | ------- |
| QV-01 | Contracts: `quote-mismatch` reason, normalized substring check, `evidenceTexts` optional third arg    | Plan row exists | `tests` |
| QV-02 | Storage + runtime: owner-scoped `excerptsById` read, `answerResponse` passes excerpts into assessment | QV-01 green     | `tests` |
| QV-03 | Gates: `check:fast`, `eval:offline`, signals feedback; evidence here                                  | QV-01..02 green | `evals` |

Out of scope: `conflicting` entailment verdicts, stale-metadata checks,
report/export quote surfacing (schemas stay quote-less — receipt metadata,
not report content).

## Decision notes

- Method: vertical-event-slice. No spike: pure deterministic check + one
  owner-scoped `SELECT id, excerpt` read mirroring `existingIds`.
- Normalization: `lowercase + collapse \s+ + trim`. Case/whitespace
  differences never fail; semantic paraphrase still fails (by design —
  quote means verbatim span, not paraphrase).
- Precedence (deterministic): `no-citations` > `malformed-citations` >
  `no-citations-resolve` > `some-citations-missing` > `quote-mismatch` >
  `upstream-unresolved-flag` > `all-citations-resolve`. Structural
  missing takes precedence over quote content; quote is checked only when
  every cited id exists and is well-formed.
- `evidenceTexts` absent = no validation (backward compat, plan-070
  behavior). Present + at least one resolved excerpt: quote must be a
  substring of some resolved excerpt. Missing map entry for a resolved id
  counts as mismatch (cannot verify = not grounded).
- Support on mismatch: `partially-supported`, uncertainty `partial` —
  the claim cites real evidence but the verbatim span is not in it.
- `exactOptionalPropertyTypes` respected: third arg optional via
  `evidenceTexts?: ReadonlyMap<string,string> | undefined`, conditional
  handling only.

## Evidence

- Red: new `scripts/test/claims.test.ts` validation cases (mismatch +
  normalization) failed before the fix (`reason` stayed
  `all-citations-resolve`); new runtime mismatch case failed before
  wiring (`support` stayed `supported`).
- Green: `scripts/test/claims.test.ts` — PASS 9/9 (2 new validation
  cases); `packages/contracts/test/answer-quote.test.ts` — PASS 4/4
  (unchanged plumbing); `packages/server/test/runtime-claims.test.ts` —
  PASS 4/4 (1 new `quote-mismatch` wiring case).
- `npm run check:fast` — PASS 9/9.
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; SQLITE_FULL lines are expected
  degradation-fixture logging).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary. `excerptsById` is owner- +
  tenant-scoped like `existingIds` (foreign ids simply miss and assess
  as mismatch/unresolved); quote stays echoed verbatim, never executed
  or rendered as trusted; report/export schemas still exclude quotes.
  Residual: `supported` remains structural + verbatim-span only, never
  entailment; paraphrase still fails by design.
