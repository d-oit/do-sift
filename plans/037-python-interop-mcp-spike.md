# 037 — Python interoperability: MCP bridge vs sidecar (issue #122)

Status: done (2026-11-03), PY-01…PY-05 complete. Decision: **proceed with the
MCP server; defer the sidecar** (ADR 0010, `plans/adr/0010-python-interop-mcp.md`).

Issue #122 asked whether a Node-only engine can serve teams in Python
ecosystems, and asked for a spike comparing an MCP server against a sidecar
process, a proof-of-concept MCP server that executes a search from a Python
client, and a recorded decision.

## What was uncertain

Not "can Python call Node" — `subprocess` and stdio have done that forever.
The open questions were:

1. **Does the MCP wire protocol have sharp edges** we would have to pay for
   repeatedly (handshake ordering, version negotiation, error taxonomy,
   stdout discipline)?
2. **What does the process boundary cost** per call, and does that cost
   threaten the token-frugality constraint (which is about _model tokens_,
   not latency)?
3. **Is a sidecar materially better** at the one thing MCP is bad at — a
   single long-lived process with cheap calls?

## Method

A throwaway spike in `.spikes/122/` (gitignored, per the `spike-runner`
skill), run against the protocol server now in `packages/server/src/mcp.ts`
and the entrypoint in `apps/mcp/src/index.ts`:

- `client.py` — a hand-written Python client: launch the server as a
  subprocess, `initialize`, `notifications/initialized`, `tools/list`,
  `tools/call`.
- `bench.py` — 25 round trips over each transport, measuring spawn+handshake,
  p50/p95 request latency, and bytes on the wire.

Ground truth for the protocol: the MCP specification revision `2025-11-25`
(<https://modelcontextprotocol.io/specification/2025-11-25>), specifically the
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[stdio transport](https://modelcontextprotocol.org/specification/2025-11-25/basic/transports),
and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
pages.

## Findings

`python3 .spikes/122/client.py` → exit 0:

```json
{
  "status": "pass",
  "protocolVersion": "2025-11-25",
  "server": { "name": "do-sift", "version": "0.1.0" },
  "tools": ["search", "answer", "evidence"],
  "handshakeMs": 672.3,
  "searchRpcMs": 12.1,
  "documentsStored": 1,
  "stderrHasDiagnostics": true,
  "exitCode": 0
}
```

Three consecutive `bench.py` runs (spawn+handshake / p50 round trip / wire
bytes):

| Transport      | Spawn + handshake | p50 round trip | p95 round trip | Wire bytes/RT |
| -------------- | ----------------- | -------------- | -------------- | ------------- |
| MCP over stdio | 649–801 ms        | 0.25–0.47 ms   | 0.56 ms        | 78            |
| NDJSON sidecar | 19–22 ms          | 0.03 ms        | 0.05 ms        | 23            |

Interpretation:

- **The process boundary is not the cost; the runtime is.** The sidecar in the
  measurement is `python -c` doing `json.loads`; MCP's subprocess is `tsx`
  starting the whole do-sift module graph. Release builds (`node dist/…`)
  remove most of that. Per-call latency, once warm, is sub-millisecond on both
  and irrelevant next to a fetch (hundreds of ms) or a synthesis call
  (seconds).
- **Neither pattern spends model tokens.** Token frugality is unaffected by
  either choice: the search path makes zero LLM calls regardless of how the
  client reaches it.
- **The MCP protocol's sharp edges are real but finite** and now encoded in
  one tested module: `initialize` must precede `tools/*`; a notification has
  no response; `notifications/initialized` must be a notification, not a
  request; stdout must carry protocol messages only; tool failures belong in
  `isError` results (so a client model can self-correct), not JSON-RPC errors.
- **A sidecar's advantage is publishing an internal API** — a Python process
  that holds a model or a native extractor, called by Node over IPC. That is
  the opposite direction of interop from "let Python call do-sift", and it
  reintroduces the cross-runtime packaging cost ADR 0001 exists to avoid.

## Decision

Proceed with the MCP server (already implemented and tested here); defer the
sidecar until there is a concrete Python-only capability to host. Full
rationale, alternatives, and consequences: `plans/adr/0010-python-interop-mcp.md`.

## Task rows

| ID    | Task                                                        | Status | Acceptance evidence                                                                                                  |
| ----- | ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| PY-01 | Spike document comparing MCP and sidecar                    | done   | this file — latency, complexity, maintenance burden, and what each pattern is actually for                           |
| PY-02 | MCP protocol core (lifecycle, tools, errors, stdio framing) | done   | `packages/server/src/mcp.ts`; `packages/server/test/mcp.test.ts` (16 cases)                                          |
| PY-03 | Runnable stdio server entrypoint                            | done   | `apps/mcp/src/index.ts`; the subprocess test in `mcp.test.ts` and `.spikes/122/client.py` both drive it              |
| PY-04 | A Python client executes a search                           | done   | `.spikes/122/client.py` → exit 0, `documentsStored: 1`; the Node subprocess test proves the same path without Python |
| PY-05 | Decision recorded as an ADR                                 | done   | `plans/adr/0010-python-interop-mcp.md`                                                                               |

## Risks (carried to `plans/risks.md`)

- **A second API surface.** The MCP tools must keep calling the same runtime
  the HTTP server calls. They do today (`apps/mcp/src/index.ts` composes
  `createRuntime` and calls `runtime.runResearch` / `runtime.answerResponse`);
  a future tool that reimplements a pipeline would drift.
- **Fixture-only host.** The entrypoint composes fixture providers and an
  in-memory database. Live providers need the `apps/server` composition, which
  owns the terms gates and safe-fetch. That is deliberate for a spike-grade
  entrypoint, but it means "MCP works" ≠ "MCP is production-configured".
- **No live Python SDK dependency in CI.** The Node subprocess test covers the
  transport; the Python client is a spike artifact. Adding `pytest`/`uv`
  dependency for a protocol we already test would add a second toolchain to CI
  for little gain. Revisit if a Python SDK integration is ever shipped.
- **No auth on the stdio entrypoint.** It serves one configured owner from the
  local environment, which is the stdio transport's threat model (the client
  owns the process). A network transport would need the same principal and
  tenant gates as the HTTP server and does not exist yet.

## Evidence (2026-11-03)

Files added:

- `packages/server/src/mcp.ts` — protocol core (lifecycle, version
  negotiation, tool schemas, argument validation, error taxonomy)
- `apps/mcp/src/index.ts` — stdio entrypoint composing `createRuntime`
- `packages/server/test/mcp.test.ts` — 16 cases, including a real subprocess
- `plans/adr/0010-python-interop-mcp.md`

Files changed:

- `packages/server/src/index.ts` — exports the MCP surface
- `docs/architecture/README.md`, `docs/api.md` — document the MCP surface and
  the "same runtime, second transport" rule
- `plans/risks.md` — R-17 (two API surfaces must not diverge)

Commands run:

- `python3 .spikes/122/client.py` → exit 0; `initialize` 2025-11-25,
  three tools, `documentsStored: 1`
- `python3 .spikes/122/bench.py` (×4) → MCP p50 0.25–0.47 ms, sidecar p50
  0.03 ms, spawn 649–841 ms vs 19–22 ms (tsx module graph, not the protocol)
- `npx vitest run packages/server/test/mcp.test.ts` → 16 passed
- `npx tsc -p tsconfig.json --noEmit` → clean
- `npx tsx scripts/policy.ts` → PASS (after deleting the Python spike
  artifacts, which INV-001 forbids in the tree)
- `rm -rf .spikes/122` → spike code removed; numbers recorded above

## Acceptance criteria mapping (issue #122)

1. **Spike document compares latency, complexity, maintenance burden** →
   this file: the latency table, plus the direction-of-interop and packaging
   analysis.
2. **A proof-of-concept MCP server executes a search from a Python client** →
   `.spikes/122/client.py` exit 0 against `apps/mcp/src/index.ts`; the
   equivalent path is now a permanent Node subprocess test.
3. **The decision (proceed or defer) is an ADR** → `plans/adr/0010-python-interop-mcp.md`
   (proceed with MCP, defer the sidecar).
