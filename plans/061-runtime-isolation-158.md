# Plan 061 — Research source-callback isolation for issue #158

Status: in-progress (slice, 2026-11-25). Owner: maintainer. Issue #158 notes
`plans/011-ret-baseline.md` accepted a shared `onSource` callback slot with
serialization as a temporary constraint; the server now serves concurrent
requests, so callback state must not leak between runs.

Findings so far (read-only, 2026-11-25): the shared slot is already gone on
the hot path — `packages/server/src/runtime.ts` builds a per-call
`onSourceForRun` closure, `server.ts` passes a per-request SSE closure, and
the harness (`packages/plugins/plugin-harness-research/src/index.ts`)
resolves `task.onSource ?? deps.onSource` per `run()` call. The remaining
`deps.onSource` field is a vestigial fallback no caller sets. What is
missing is proof: no test runs two overlapping runs against one harness
instance and asserts no cross-delivery.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                             | Preconditions                                                 | Sensor  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------- |
| RSC-01 | Overlap regression test: two concurrent `harness.run` on one instance, distinct per-run collectors, equal non-zero delivery each | Plan row exists (this file); #158 test criterion quoted above | `tests` |
| RSC-02 | Remove-or-deprecate decision for the vestigial `deps.onSource` fallback (contract change; compat only if a real caller needs it) | RSC-01 green; caller survey done (none set it)                | `tests` |
| RSC-03 | Run-correlation context (`requestId` already on summary; confirm `runId`/tenant/owner on events or record gap)                   | RSC-01 green                                                  | `tests` |
| RSC-04 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                                    | RSC-01..03 scoped (03 may defer with reason)                  | `evals` |

Out of scope for this slice: SSE backpressure policy, plan 011 doc update
(after verification), cross-tenant event test (needs tenant harness
fixture).

Method: vertical-event-slice. No spike: the `run()` contract and
`research-harness-support.ts` fixture already exist; overlap is forced with
a delayed `fetchPage`.

## Decision notes

- Equal-count assertion is the isolation signal: with a shared slot,
  last-writer-wins would deliver 2N to one collector and 0 to the other.
- `deps.onSource` removal is RSC-02, not this slice: it changes the plugin
  contract and needs its own red test (precedence or removal).

## Evidence (2026-11-25, branch `docs/061-runtime-isolation-158`)

- Red proof by mutation: with `task.onSource` ignored (shared-slot
  simulation), the new test fails (1 failed); with per-run routing it
  passes. The isolation already held — this slice locks it in.
- Green: harness package suite PASS 36/36 (4 files, incl. the new overlap test).
- `npm run check:fast` — PASS 9/9.
- `npm run check` — PASS 12/12 (tests + evals + build).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (test-only change + plan;
  no inputs, outputs, privilege, or workflow changes).
