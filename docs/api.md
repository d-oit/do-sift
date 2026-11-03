# HTTP API reference

This describes the research server's HTTP surface as implemented in
`packages/server/src/server.ts` and `packages/server/src/answer.ts`. Operational
settings (listen address, limits, owners, providers) are in
`docs/deployment.md`.

## Authentication

Every route except `GET /healthz` and `GET /readyz` requires an owner:

- `Authorization: Bearer <id token>` verified by the configured OIDC verifier, or
- the loopback-only dev bypass (`DO_SIFT_DEV_BYPASS=1`), which acts as
  `DO_SIFT_DEV_OWNER`.

Failed authentication returns `401` with a JSON error. Owners outside
`DO_SIFT_OWNERS` are refused.

## Common behaviour

- Every response carries a server-generated `X-Request-Id`. SSE events repeat it.
- Error responses are JSON: `{"error": "<message>", "requestId": "<id>"}`.
  Messages are generic on purpose; internal error text is never returned.
- Error responses set `cache-control: no-store` and close the connection after
  the response is flushed.

## Routes

| Method | Path            | Purpose                                            |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/`             | Source-card web page (HTML)                        |
| GET    | `/healthz`      | Liveness: `{"ok":true}`, no auth, no storage calls |
| GET    | `/readyz`       | Readiness: `{"ok":true}` or `503 {"ok":false}`     |
| POST   | `/api/research` | Research run, streamed as SSE                      |
| POST   | `/api/answer`   | Grounded answer, JSON                              |
| GET    | `/api/evidence` | Newest stored sources of the caller's own corpus   |
| GET    | `/api/answers`  | Newest stored answers of the caller's own corpus   |

Other paths return `404`. Wrong methods on the POST routes return `405`.

## GET /api/evidence and GET /api/answers

Read-only views of what the caller has already stored (`viewer`, `member`, and
`owner` all have them; a caller with no recorded membership is refused). Both
are scoped by the authenticated principal — the owner is the token's user and
the tenant is the token's tenant, never a query parameter — and neither
reserves budget nor writes a row.

| Route                             | Payload                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/evidence?limit=<1..50>` | `{"evidence":[{"id","url","title"?,"fetchedAt"}]}` — newest first, default 20           |
| `GET /api/answers?limit=<1..50>`  | `{"answers":[{"id","question","evidenceOnly","createdAt"}]}` — newest first, default 20 |

Provenance only: the evidence list carries no page text, and the answer list
carries no blocks or token usage. An out-of-range or non-numeric `limit` is
`400` (not silently clamped), a non-`GET` method is `405`, and both paths are
ordinary `404`s when the host has not configured a read surface.

### Paging

Both lists page, so a corpus larger than one page stays reachable instead of
stopping at the newest 50 rows. A page is ordered by the timestamp the payload
exposes — `fetchedAt` for evidence, `createdAt` for answers — newest first, with
the row id as a stable tie-breaker so rows sharing a timestamp cannot be
repeated or skipped.

When more rows exist the response carries `nextCursor`; send it back as
`?cursor=<value>`, keeping `limit` (or choosing another) to continue. The cursor
is opaque and carries no authority: a forged one can only move the window inside
the caller's own owner- and tenant-scoped rows, never reach another member's. A
malformed cursor is a `400`, the same as a bad `limit`, rather than an ignored
parameter that silently restarts the list.

## Request bodies (POST routes)

- `Content-Type: application/json` is required (parameters such as `charset`
  are accepted). Otherwise the response is `415`.
- The body is limited to 8,192 bytes (`413` above that).
- A body that stalls for ten seconds returns `408`.
- Malformed JSON, or a missing or empty `question`, returns `400`.

Body shape for both POST routes:

```json
{ "question": "string" }
```

## POST /api/research (SSE)

Responds `200` with `content-type: text/event-stream`. The server sends a
`: heartbeat` comment periodically while a run is active. Events:

- `event: source`: one `SourceCard` per source as evidence lands.
  Fields: `url`, `title` (optional), `passageCount`, `relevanceScore` (optional,
  a stored similarity receipt), `relevanceLow` (optional, a UI prominence
  verdict). Receipts are shown, never hidden.
- `event: done`: the run summary. Fields: `hits`, `documentsStored`,
  `documentsReused` (optional), `passagesStored`, `denied`, `fetchErrors`,
  `skippedBudget`, `providerHealth` (optional; present for merged search
  providers, one entry per provider with `ok` and an optional `error`).
- `event: error`: `{"message": "research failed"}` when the run throws after the
  stream has started. The detail stays in the operator logs.

Every event's data is JSON and includes `requestId`.

If the client disconnects, the run is cancelled and no further events are written.

## POST /api/answer

Returns `200 application/json` with the answer outcome:

- `requestId`, `answerId`
- `cached`: `true` on an exact-answer cache hit (nothing re-ran)
- `degraded`: `true` when the answer is not fully grounded — no evidence,
  some claim's citations failed validation, or the model provider failed.
  Citations are validated against stored evidence and there is no repair loop:
  claims whose citations resolve are kept, the rest are flagged unresolved.
- `evidenceOnly`: `true` when the answer has no model claims. A provider
  failure falls back to evidence-only output (HTTP 200), and an answer where
  no claim survives citation validation also degrades to evidence-only.
- `degradationReason`: `"no-evidence"`, `"citation-invalid"`, or
  `"model-failed"` when degraded; absent on grounded answers.
- Answer blocks may carry `unresolved: true` when that claim's citations did
  not resolve; its `citations` array then contains only the ids that did
  (possibly empty). The bundled page labels such blocks UNRESOLVED and never
  presents them as grounded.
- `evidenceFromRun`: `"run"`, `"legacy"`, or `"cross-question"`. Undefined when
  nothing was retrieved.
- `usage`, `reconciliation` (settle-time usage versus the reservation), and
  `suspectEvidence` (an advisory receipt, never a filter). Some fields are absent
  on cache hits and on the empty-evidence path.

Status codes:

| Status | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| 200    | Answer returned (possibly degraded, partial, or evidence-only)       |
| 400    | Bad JSON or question                                                 |
| 401    | Authentication failed                                                |
| 405    | Wrong method                                                         |
| 408    | Body read timed out                                                  |
| 413    | Body too large                                                       |
| 415    | Content type is not JSON                                             |
| 429    | Owner over its concurrency or per-minute limit; `Retry-After` is set |
| 500    | Answer path failed after the model call (storage or internal error)  |
| 501    | Answer surface not configured (`DO_SIFT_MODEL_PROVIDER` unset)       |

Budget exhaustion is reported as degraded or evidence-only output, not as an
HTTP error.

## Health

`GET /readyz` probes the libSQL connection with `SELECT 1` under a one-second
deadline. Concurrent probes share one in-flight check. It does not call search
or model providers.

## Model Context Protocol (MCP) surface

The engine is also reachable over the Model Context Protocol, so a non-Node
client (a Python agent or notebook) can run a search without an HTTP deployment.
It is a **second transport over the same runtime**, not a second API: every
tool call goes through the same `Runtime` methods the routes above use, so the
citation check, the terms gates, and the zero-LLM search discipline apply
unchanged.

Run it as a stdio subprocess:

```
npx tsx apps/mcp/src/index.ts
```

Environment: `DO_SIFT_DB_URL` (default `:memory:`), `DO_SIFT_MCP_OWNER`
(default `mcp-owner`), `DO_SIFT_MCP_TENANT` (default `default`).

Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, per the MCP
specification revision `2025-11-25`. stdout carries protocol messages only;
diagnostics go to stderr. The handshake is `initialize` →
`notifications/initialized`.

| Tool       | Arguments                                 | Effect                                                                                                        |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `search`   | `question` (1-2000 chars), `limit` (1-20) | Zero-LLM search: query providers, store evidence with provenance. Returns the run summary, not the page text. |
| `answer`   | `question`                                | One bounded synthesis call over stored evidence, with citation validation. Degrades to evidence-only output.  |
| `evidence` | `limit` (1-50)                            | The newest stored sources for the caller: id, URL, title, fetch time. No page text, no answer blocks.         |

A host that lacks a capability does not advertise the tool (`tools/list` is
derived from the composed host). Validation and execution failures come back
as `isError: true` tool results rather than JSON-RPC errors, which is what the
specification asks for so a client model can self-correct.

Limits, recorded as R-18/R-19 in `plans/risks.md`: the entrypoint is
stdio-only and single-owner — it has no principal or tenant authentication,
which is the stdio transport's threat model (the client owns the process). A
network transport would have to reuse the HTTP server's authentication and
role gates before it could exist.
