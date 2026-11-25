# Plan 062 — Remove the harness deps-level onSource fallback (issue #158, RSC-02)

Status: in-progress (slice, 2026-11-25). Owner: maintainer. Completes
RSC-02 from plan 061. The plan-061 survey ("no caller sets it") was wrong:
`packages/server/test/server-support.ts` sets deps-level `onSource` and
runs without a per-run callback — the last real user of the shared slot.
This slice migrates that caller to per-run delivery and removes the
fallback, so per-run is the only channel.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                                                   | Preconditions               | Sensor  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------- |
| RSO-01 | Red test: deps-level `onSource` (via untyped object) is not consulted; run without `task.onSource` delivers nowhere but still stores                   | Plan row exists (this file) | `tests` |
| RSO-02 | Remove `onSource` from `ResearchHarnessDeps`, resolve `task.onSource` only, migrate `server-support.ts` to per-run, drop harness test-support plumbing | RSO-01 red shown            | `tests` |
| RSO-03 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                                                          | RSO-01..02 green            | `evals` |

## Evidence (2026-11-25, branch `docs/062-deps-onsource-158`)

- Red: RSO-01 test failed before the removal (1 failed / 1 passed in the
  isolation file) — deps-level delivery observed.
- Green after: isolation file 2/2; harness package 37/37;
  harness + server suites 241/241 (25 files).
- `npm run check:fast` — PASS 9/9; `npm run check` — PASS 12/12.
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (removal narrows the API;
  no inputs/outputs/privilege changes). One fix during the slice: the
  plan-061 survey missed two evidence-test callers of the fallback —
  migrated to per-run in this slice.
- Correction to plan 061: `deps.onSource` did have one real caller
  (`server/test/server-support.ts`), now migrated.

Out of scope: run-correlation context (RSC-03), SSE backpressure, plan 011
doc update.

Method: vertical-event-slice. No spike: one caller, one field, one line.

## Decision notes

- Removal (not deprecation): the field is a cross-run leak vector by
  design, and the single caller is test support we own. TypeScript callers
  get a compile-time signal; untyped callers get silence, which matches
  "no callback configured" semantics.
- `task.onSource` comment updated: it is the channel, not an override.
