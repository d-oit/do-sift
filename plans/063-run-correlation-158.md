# Plan 063 — Run-correlation context on research events (issue #158, RSC-03)

Status: in-progress (slice, 2026-11-26). Owner: maintainer.

## Problem

Concurrent runs share one harness instance and one host event bus.
`research.completed` already carries `ownerId` + `requestId`, but the
three advisory failure events carry only `{ message }` — unattributable
when two runs degrade at once. `ResearchSourceEvent` carries no run
identity either, so a forwarded receipt is not self-describing.

## Task IDs (htn-planner, ordered)

| ID     | Task                                                                                                                                                                                                 | Preconditions               | Sensor  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| RCO-01 | Red test: failure payloads + source receipts carry run identity                                                                                                                                      | Plan row exists (this file) | `tests` |
| RCO-02 | Add `ownerId` + `requestId` + `tenantId` to `research.relevance-failed`, `research.embeddings-failed`, `research.noise-backfill-failed`; add `requestId` to `ResearchSourceEvent` at both emit sites | RCO-01 red shown            | `tests` |
| RCO-03 | Gates: `npm run check:fast`, `npm run check`, signals feedback; evidence here                                                                                                                        | RCO-01..02 green            | `evals` |

Out of scope: SSE backpressure policy, plan 011 doc update, `SourceCard`
contract changes (the server picks receipt fields; nothing leaks).

## Decision notes

- `tenantId` comes from `deps.repositories.tenantId` (host-scoped,
  always a non-empty string): owner ids are only unique within a tenant,
  so bus attribution needs all three.
- `ResearchSourceEvent.requestId` is required (not optional): a run
  always has a request row (ANS-07), and a receipt without run identity
  is the exact gap this slice closes. No `exactOptionalPropertyTypes`
  hazard — the value is a plain `string` at both sites.
- Method: vertical-event-slice. No spike: four emit sites, one interface.

## Evidence

- Red: RCO-01 test failed before the change (payloads lacked identity).
- Green after: isolation file 3/3; harness package 38/38.
- `npm run check:fast` — PASS 9/9; `npm run check` — PASS 12/12.
- `npm run signals -- verify --set feedback` — green.
