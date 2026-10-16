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

Other paths return `404`. Wrong methods on the POST routes return `405`.

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
- `degraded`: `true` when the model's citations failed validation or there was
  no evidence. Citations are validated against stored evidence; invalid
  citations degrade to evidence-only output, with no repair loop.
- `evidenceOnly`: `true` when the answer has no model claims
- `evidenceFromRun`: `"run"`, `"legacy"`, or `"cross-question"`. Undefined when
  nothing was retrieved.
- `usage`, `reconciliation` (settle-time usage versus the reservation), and
  `suspectEvidence` (an advisory receipt, never a filter). Some fields are absent
  on cache hits and on the empty-evidence path.

Status codes:

| Status | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| 200    | Answer returned (possibly degraded or evidence-only)                 |
| 400    | Bad JSON or question                                                 |
| 401    | Authentication failed                                                |
| 405    | Wrong method                                                         |
| 408    | Body read timed out                                                  |
| 413    | Body too large                                                       |
| 415    | Content type is not JSON                                             |
| 429    | Owner over its concurrency or per-minute limit; `Retry-After` is set |
| 500    | Answer path failed (generic message)                                 |
| 501    | Answer surface not configured (`DO_SIFT_MODEL_PROVIDER` unset)       |

Budget exhaustion is reported as degraded or evidence-only output, not as an
HTTP error.

## Health

`GET /readyz` probes the libSQL connection with `SELECT 1` under a one-second
deadline. Concurrent probes share one in-flight check. It does not call search
or model providers.
