# MCP protocol audit (#166)

The stdio bridge in `packages/server/src/mcp.ts` is a transport adapter over the
same host functions the HTTP server uses. It performs no fetching, storing, or
billing on its own.

## Advertised revisions

`SUPPORTED_PROTOCOL_VERSIONS` is `2025-11-25`, `2025-06-18`, `2025-03-26`.
The bridge echoes a client's requested revision when it is in that list and
otherwise offers the newest supported one. A revision is **not** advertised
until the conformance checks below cover it.

## What is implemented

- Newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go to stderr.
- Lifecycle: `initialize` → `notifications/initialized` → `tools/list` /
  `tools/call`, plus `ping`.
- Tool failures are returned as `isError` results, as the specification asks,
  so a client model can self-correct.
- Arguments are validated against each tool's JSON schema (types, bounds,
  required keys, additional properties).

## Conformance coverage

`packages/server/test/mcp.test.ts` pins:

- negotiation for every advertised revision and the fallback for unknown ones;
- parse errors, invalid requests, unknown methods, unknown tools;
- schema rejection for missing/extra/out-of-range arguments;
- notification handling (no response line);
- tool result shape, including error results.

## Deliberately not claimed

- Revisions newer than `2025-11-25` are not silently accepted. A future
  stateless-core revision needs its own conformance fixtures before it is
  added to the list.
- HTTP/SSE transports are not implemented; only stdio is served.
- Authentication is the host's responsibility: the bridge is embedded in a
  process whose host functions are already owner-scoped.

## Adding a revision

1. Add conformance fixtures for the revision's changed lifecycle/serving
   rules.
2. Add the revision to `SUPPORTED_PROTOCOL_VERSIONS` only after the fixtures
   pass.
3. Update this document and the `initialize` instructions if tool semantics
   changed.
