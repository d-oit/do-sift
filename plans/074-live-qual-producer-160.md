# Plan 074 — Live QUAL coverage for the #160 producer surface

Status: done (slice, 2026-11-27). Owner: maintainer. Follows plan
073 (provenance advisory). Direction: user-chosen "Live QUAL".

The real live-model re-measure stays owner-gated (paid spend, terms,
sources entry, credentials — approval boundary, not this slice). This
slice makes that future run cover the #160 surface: the corpus gains a
quote-exercising case, and the runner records producer quote/conflict
behavior as observation-only receipt data.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                            | Preconditions   | Sensor  |
| ----- | --------------------------------------------------------------------------------------------------------------- | --------------- | ------- |
| LQ-01 | Corpus: `live-case-09` quote-carrying evidence (benign, quotable spans, mock-passing expectations)              | Plan row exists | `tests` |
| LQ-02 | Runner: optional `quote`/`conflicting` on draft blocks; per-case `producerBehavior` observation (no scoring)    | LQ-01 green     | `tests` |
| LQ-03 | Gates: mock live-eval to /tmp (no repo artifact), `check:fast`, `eval:offline`, signals feedback; evidence here | LQ-01..02 green | `evals` |
| LQ-04 | PR + #160 comment                                                                                               | LQ-03 green     | —       |

Out of scope: any real live-model run (owner-gated spend); scoring or
threshold changes (answer-text quality is authorial per quality-gate
limits — the machine gate must not judge quote quality); schemaVersion
bump (additive case, runner-tolerant); provenance in eval-live (no
storage layer on that path — covered by plan-073 unit tests).

## Decision notes

- Method: vertical-event-slice. No spike: the mock-provider path is
  deterministic and already exercised in CI-adjacent tooling.
- `producerBehavior` is observation, not gate: `{ quotesEmitted,
conflictFlagged }` per case in `RawCaseMetadata`. Fixture-model runs
  record zeros; a future live run records what the model actually did.
  Thresholds and scores untouched.
- `live-case-06` (conflicting-stale-sources) already covers disagreeing
  passages structurally; LQ adds no duplicate — case-09 covers the quote
  invitation, and the observation fields cover both under a live model.
- Mock live-eval output goes to `/tmp` (throwaway, never committed):
  a fixture-model artifact in `evals/quality/` would masquerade as a
  QUAL run.
- Red-first: new `scripts/test/eval-live-observations.test.ts` calls
  `runLiveEval` with mock flags to a temp path, asserting the
  observation fields exist — fails pre-fix (fields absent), passes after.

## Evidence

- Red: new `scripts/test/eval-live-observations.test.ts` failed pre-fix
  (no `live-case-09` in the corpus, no `producerBehavior` on case
  metadata); green after (`1 passed`).
- Green: mock live-eval inside that test — `passed: true` over 9 corpus
  cases, all `producerBehavior` zeros as expected from the fixture model
  (observation, not gate). Artifact written to a throwaway temp path;
  no `evals/quality/` artifact committed.
- `npm run check:fast` — PASS 9/9.
- `npm run eval:offline` — PASS (deterministic cases, 0 external
  network calls, 0 paid model calls).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary. Corpus addition is benign
  text; `producerBehavior` counts block fields already returned by the
  model plugin and records them into the artifact — no prompt, storage,
  or network change. Residual: the real live-model re-measure stays
  owner-gated (paid spend + terms + sources entry + credentials).
