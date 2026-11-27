# Plan 073 — Cited-evidence provenance for issue #160 (stale metadata)

Status: done (slice, 2026-11-27). Owner: maintainer. Follows plan 072
(producer-flagged conflict). Direction (user-chosen 2026-11-27): stale
metadata.

There is no deterministic freshness verdict: "stale" needs an arbitrary age
cutoff, and a cutoff is a policy judgment, not evidence (same overreach as
entailment, ADR 0003/0004). So this slice does NOT add a stale flag, reason,
or support change. It surfaces the metadata a reader needs to judge
freshness — per-cited-passage `retrievedAt`/`publishedAt` — as advisory
receipt data. The system never declares evidence stale.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                           | Preconditions   | Sensor  |
| ----- | ---------------------------------------------------------------------------------------------- | --------------- | ------- |
| SM-01 | Contracts: `evidenceProvenance` 4th arg on `assessClaims`, `provenance` echo on resolved cites | Plan row exists | `tests` |
| SM-02 | Storage `provenanceById` (passages→documents join, owner-scoped) + runtime wiring + docs/api   | SM-01 green     | `tests` |
| SM-03 | Gates: `check:fast`, `eval:offline`, signals feedback; evidence here                           | SM-01..02 green | `evals` |

Out of scope: any stale/fresh verdict, age cutoff, support or reason change
for old evidence, live QUAL, report/export surfacing (receipt metadata —
same boundary as quotes/flags in plans 070/071/072).

## Decision notes

- Method: vertical-event-slice. No spike: the join pattern already exists
  (`passages.compareSources` returns `fetched_at`/`published_at`); this
  adds a narrower read mirroring `excerptsById`.
- Semantics: `provenance` is advisory data, not validation. Missing map
  entry for a resolved id is omitted from the echo with no penalty
  (contrast `quote-mismatch`, where unverifiable = not grounded — a quote
  asserts content, provenance asserts nothing).
- Support/reason untouched: old evidence keeps whatever structural verdict
  it earned. No new `ClaimReason`; no cutoff anywhere in the codebase.
- Fetch policy: `runtime.answerResponse` reads provenance whenever the
  stored answer cites anything (`cited.length > 0`) — staleness is visible
  by default, not opt-in. Skipped only when nothing is cited. One indexed
  join read; no new read on the empty-evidence path.
- `retrievedAt` = parent document `fetched_at`; `publishedAt` = parent
  document `published_at` when known (omitted otherwise, never invented).
- `exactOptionalPropertyTypes` respected with conditional spreads.

## Evidence

- Red: new `scripts/test/claims.test.ts` provenance cases (echo +
  absent-compat) failed 2/2 on stashed (pre-slice) sources — `provenance`
  stayed `undefined`; restored to green after pop.
- Green: `scripts/test/claims.test.ts` — PASS 13/13 (2 new provenance
  cases); `packages/server/test/runtime-claims.test.ts` — PASS 6/6
  (1 new provenance wiring case, owner-scoped via real `:memory:` DB).
- `npm run check:fast` — PASS 9/9.
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; stack lines in output are expected
  degradation-fixture logging).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary. `provenanceById` is owner- +
  tenant-scoped like `existingIds`/`excerptsById` (foreign ids simply
  absent); timestamps are stored receipts echoed verbatim, never
  executed; report/export schemas stay provenance-less (receipt
  metadata, not report content). Residual: no stale/fresh verdict
  exists by design — freshness stays the reader's judgment.
