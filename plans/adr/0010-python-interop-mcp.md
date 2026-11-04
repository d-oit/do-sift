# ADR 0010 — Python interop through an MCP server; sidecar deferred

Status: accepted 2026-11-03 (spike evidence in `plans/037-python-interop-mcp-spike.md`)

## Context

do-sift is Node-only (ADR 0001). Teams invested in Python — notebooks, data
pipelines, Python-hosted agents — cannot call it without writing a wrapper.
Issue #122 proposed two routes: expose the engine through the Model Context
Protocol, or run a sidecar process that hosts specific plugins and talk to it
over IPC.

The spike (`plans/037-python-interop-mcp.md`) measured both and found that
per-call latency is sub-millisecond either way once warm, that neither pattern
touches the model-token budget, and that the real difference is direction of
interop and packaging cost.

## Decision

**Publish an MCP server; do not adopt a sidecar.**

- The protocol lives in `packages/server/src/mcp.ts`: transport-free,
  JSON-RPC 2.0, `initialize` → `notifications/initialized` → `tools/list` /
  `tools/call`, stdio framing per the `2025-11-25` specification revision.
- `apps/mcp/src/index.ts` is the stdio entrypoint. It composes the same
  `createRuntime` the HTTP server uses and calls the same methods, so the MCP
  surface cannot drift into a second pipeline.
- Tools exposed: `search` (zero LLM calls), `answer` (one bounded synthesis
  call, citation-validated), `evidence` (provenance only). A host that lacks a
  capability — no model, no store — does not advertise the tool.
- Tool failures are `isError` results, not JSON-RPC errors: the specification
  asks for that so a client model can self-correct.
- stdout carries protocol messages only; diagnostics go to stderr.

**Deferred, not rejected:** a Python sidecar hosting a plugin that only exists
in Python (a custom extractor or local model). It is the right shape if such a
capability appears, and the NDJSON-over-stdio pattern measured here is the
template. Adopting it now would add a second runtime to package and test for
no capability we actually need.

## Consequences

- Python (and any other MCP-speaking host) gets the engine without a wrapper,
  and `python3 client.py` was verified against a real search (exit 0).
- One protocol module, tested in-process and through a real subprocess; no
  Python toolchain enters CI (the transport test is Node-only).
- The MCP entrypoint is local and single-owner by construction: the stdio
  transport's threat model is that the client owns the process. A network
  transport would need the HTTP server's principal and tenant gates and is out
  of scope.
- Two surfaces now call the runtime. The rule is explicit: MCP tools delegate
  to `runtime` methods and never reimplement a fetch, a retrieval, or a
  synthesis.
- If a sidecar is later adopted, it must not reintroduce a Python runtime
  requirement for the product — the Node path stays complete on its own.
