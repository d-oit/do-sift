# Plan 068 — Claim-receipt hardening for issue #160 (phase 1)

Status: in-progress (slice, 2026-11-26). Owner: maintainer. Follows #178
thinnest slice (`packages/contracts/src/claims.ts`,
`packages/server/src/claims.ts`, `runtime.answerResponse` receipt).

Issue #160 asks for a structured claim record with stable claim ID,
exact citation IDs, optional span/quote, support assessment and
uncertainty/abstention reason; strict citation validation (malformed,
missing, cross-owner/tenant); and an honest resolution-vs-support
split with no second synthesis call.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                        | Preconditions               | Sensor  |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| CL-01 | Contracts: stable output `id` per claim, machine-readable `reason`, malformed-ID rejection (never resolved) | Plan row exists (this file) | `tests` |
| CL-02 | Server passthrough (`claims.ts`, `runtime.answerResponse`): caller IDs preserved, generated otherwise       | CL-01 green                 | `tests` |
| CL-03 | Gates: `check:fast`, `eval:offline`, signals feedback; evidence here                                        | CL-01..02 green             | `evals` |

Out of scope for this slice: quote/span substring validation (needs
passage texts at the assessment site — `runtime` currently passes IDs
only), `conflicting` entailment verdicts (existence is not entailment,
ADR 0003/0004), stale-metadata checks, live QUAL additions. Recorded
as follow-ups; this slice must not imply them.

## Decision notes

- Method: vertical-event-slice. No spike: pure deterministic function.
- `id`: caller may supply `ClaimInput.id`; blank/absent generates
  `claim-<index+1>`. Output `ClaimAssessment.id` is always non-empty.
  Duplicate caller IDs are preserved verbatim (receipt echoes the
  producer); uniqueness across claims is the producer's contract.
- `reason` codes: `all-citations-resolve`, `some-citations-missing`,
  `no-citations-resolve`, `no-citations`,
  `upstream-unresolved-flag`, `malformed-citations`. Malformed
  (non-string, empty/whitespace) IDs are never counted as resolved;
  they land in `unresolved` so the claim degrades honestly.
- Support union unchanged (`supported` / `partially-supported` /
  `unresolved` / `no-citation`): `supported` still means every cited
  id exists — never entailment. `conflicting`/`unassessed` stay
  follow-ups until a deterministic, evidenced detector exists.
- Ownership/cross-tenant: already enforced at the read site —
  `repositories.passages.existingIds` scopes by `tenant_id + owner_id`
  (`packages/storage/src/repositories.ts`), so foreign IDs simply miss
  and assess as unresolved. No new DB plumbing in this slice.
- Single-synthesis-call and zero-search-LLM discipline untouched.

## Evidence

- Red: new `scripts/test/claims.test.ts` cases (stable ids/reasons,
  malformed rejection) failed 2/6 before the fix (`reason` undefined).
- Green: `npx vitest run scripts/test/claims.test.ts` — PASS 6/6;
  `packages/server/test/runtime-claims.test.ts` — PASS 3/3 (unchanged
  wiring, generated `claim-N` ids).
- `npm run check:fast` — PASS 9/9 (after prettier write on the touched
  files + this plan).
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; baselines untouched; stack lines
  in output are expected degradation-fixture logging).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (pure deterministic receipt
  over caller rows + owner-scoped `existingIds`; malformed ids degrade
  honestly, never resolve). Residual: `supported` remains structural
  (existence only, never entailment); quote/span validation,
  `conflicting` verdicts, stale-metadata and live QUAL cases stay
  follow-ups and must not be claimed.
