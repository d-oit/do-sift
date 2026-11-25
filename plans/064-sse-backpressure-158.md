# Plan 064 — SSE backpressure + plan 011 closeout (issue #158)

Status: in-progress (slice, 2026-11-26). Owner: maintainer. Closes #158.

## Problem

`handleResearch` ignores `res.write()`'s return value: a slow SSE
consumer lets two concurrent runs buffer without bound server-side.
Admission already caps 2 concurrent runs per owner (429 beyond that)
and disconnects abort the run, so the remaining gap is purely the
full-socket-buffer case.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                    | Preconditions               | Sensor  |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| SBK-01 | Red test: saturating the sink drops further sources, counts them, terminal events still write                           | Plan row exists (this file) | `tests` |
| SBK-02 | `createSseSink` in `server-http.ts`; wire into `handleResearch`; emit `dropped` before `done` when the count is nonzero | SBK-01 red shown            | `tests` |
| SBK-03 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                           | SBK-01..02 green            | `evals` |
| DOC-01 | Append #158 addendum to `plans/011-ret-baseline.md` replacing the serialize-runs note                                   | SBK-02 green                | `links` |

Out of scope: async (drain-awaiting) delivery — would need an async
`onSource` contract; the answer SSE path (same pattern, separate issue
if ever needed); client retry/`Last-Event-ID` resume.

## Decision notes

- Drop-and-count, not block: the harness `onSource` contract is
  synchronous void; pausing the run for a slow consumer would hold
  budget reservations and libSQL handles. Drops are explicit via a
  `dropped` event so the client knows the stream is lossy.
- Disconnects keep existing behavior (skip silently, run aborts via
  signal); only saturation counts as dropped.
- Method: vertical-event-slice. No spike: one helper, one call site.

## Evidence

- Red: sink test failed before the helper existed (import error).
- Green after: new file 3/3; server suite 204+3; research SSE tests unaffected.
- `npm run check:fast` — PASS 9/9; `npm run check` — PASS 12/12.
- `npm run signals -- verify --set feedback` — green.
