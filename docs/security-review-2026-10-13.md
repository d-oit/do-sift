# Security review — answer-path evidence hardening change set (2026-10-13)

Scope: the R-12 hardening series — ANS-10 `packages/contracts/src/evidence-framing.ts`
(commit `c56b2d6`), ANS-11 framed prompt packing (commit `0a86bfb`), ANS-12
suspect receipts + `promptRevision` pr2 (commit `7e52aa1`), plus the
composite fixtures added by this review
(`tests/security/prompt-injection.test.ts`). Method: the `review-security`
skill — trust-boundary enumeration, recurring-offender check, a fixture per
finding class expressible as a test. This is the review note plan 013
(ANS-13) requires before the R-12 register row moves to mitigated.

Standing caveat wherever answer trust is discussed: **a validated citation
is not factual entailment** (ADR 0003 / R-06). Every gate here proves that
claims cite stored evidence, not that the evidence supports the claim.

## Trust boundaries introduced or changed

- **Inputs:** stored passage text (attacker-influenceable — the R-12
  premise) now crosses a **pack boundary** (neutralize + JSON-record frame)
  before it reaches a model prompt; `SynthesisRequest.passages` remains raw
  (the detector observes pre-neutralization text by design).
- **Outputs:** the model prompt (record framing — unforgeable line
  structure); `AnswerOutcome`/`AnswerHttpResponse` gain the advisory
  `suspectEvidence` receipt; the operational event channel gains
  `answer.suspect` (counts + stable codes only).
- **Privilege:** none new — no capabilities, no workflow changes, no policy
  or invariants changes, no new network surface.

## Findings

1. **[PASS] The evidence frame is forgery-bounded.** One neutralized JSON
   record per passage line; `frameEvidenceLine` ENFORCES neutralize-first
   (line separators throw), so passage text cannot mint records or escape
   its `text` field. Fixtures (green): `tests/security/prompt-injection.test.ts`
   "a consumer of the evidence frame sees exactly the packed records — no
   forged ids" and "the packed frame is forgery-bounded", plus the
   plugin's adversarial suite (4 cases) and `packages/contracts/test/evidence-framing.test.ts` (20 cases).
2. **[PASS] Forged evidence ids are inert.** An id shaped like `[ev-9]`
   inside passage text survives only as record text; the ANS-03 citation
   gate accepts only packed ids and degrades to evidence-only on any
   forgery — no repair loop. Fixture (green): "a forged citation degrades
   to evidence-only, no repair loop, receipt still reports".
3. **[PASS] Suspect receipts are advisory and redacted.** The receipt is
   `{passages, markers}` over raw packed text; the `answer.suspect` event
   carries counts + stable codes only — tests assert the serialized event
   never contains question text. The receipt can never change an answer's
   path (`degraded`/`evidenceOnly` untouched).
4. **[FINDING F4, LOW — accepted] id-scheme contract drift fails closed.**
   `EvidenceId` (contracts) accepts any 1..128-char string including
   whitespace, while `frameEvidenceLine` requires no whitespace. A future
   id scheme carrying whitespace would throw `EvidenceFramingError` at
   pack time → the request fails closed (status `failed`, no partial
   answer) instead of shipping a forgeable frame. Unreachable today:
   storage ids are `randomUUID()` (verified
   `packages/storage/src/repositories.ts`). Tightening `EvidenceId` was
   considered and REJECTED: it would turn a graceful citation-gate
   rejection of hostile model output into a schema-parse failure at the
   response boundary (worse degradation behavior). Pinned by fixture:
   "id-scheme drift trips review: the frame rejects whitespace ids the
   contract accepts".
5. **[PASS] Cache invalidation lands with the prompt change.** `promptRevision`
   pr1→pr2 (ANS-11 is a different prompt, D5) — pre-ANS-11 cache rows miss
   and re-answer under the framed prompt; the cache-invalidation test pins
   it. Cost note: one bounded re-answer per previously-cached question
   after deploy; budgets reconcile it.
6. **[PASS] Layering holds.** The declarative system prompt is defense in
   depth, never the only layer (structural neutralization + frame +
   citation gate + receipts each hold independently).
7. **[PASS] SSRF, authz, money, plugins, workflows:** untouched by this
   change set (no fetch code, no owner-scope changes — existing
   cross-owner fixtures green; no new calls or capabilities; workflow
   files not modified).

## Fixtures (all green, 2026-10-13)

`tests/security/prompt-injection.test.ts` (4) · `tests/security/cross-owner.test.ts`,
`budget.test.ts`, `consent.test.ts`, `ssrf.test.ts` (unchanged, green) ·
`packages/contracts/test/evidence-framing.test.ts` (20) ·
`packages/plugins/plugin-model-openai-compat/test/openai-compat-model.test.ts`
(22, incl. 4 adversarial) · `apps/server/test/main.test.ts` (32, seam stub
on the record contract).

## Residuals (recorded in `plans/risks.md` under R-12)

1. A declarative system prompt is not a guarantee; the structural layers
   REDUCE the injection surface, they do not eliminate it.
2. Live-model steering behavior is unmeasurable until first activation —
   the live QUAL re-measure remains the owner-gated follow-up.
3. The suspect detector is advisory and precision-loose; precision/recall
   over real pages is unknown until the QUAL corpus runs against live
   content (the run in `evals/quality/run-017-2026-10-13.json` uses a
   constructed corpus).
