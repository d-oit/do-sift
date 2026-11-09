# 0012 — Ship and type on Node 24 LTS

Status: accepted (2026-11-09; supersedes the Node floor in
[`0008`](0008-node-only-no-python.md) and `plans/adr/0001-typescript-node.md`)

## Context

The repository's Node pins disagreed: `.nvmrc` floated `22`,
`engines.node` said `>=22`, the `Dockerfile` used `22-slim`, Volta pinned
`22.14.0`, and `@types/node` described Node 24. The Volta pin was seven Node
22 security releases behind, and nothing in CI reads it, so the drift was
invisible. Types described a runtime the shipped image did not run.

Node 22 entered maintenance on 2025-10-21 (EOL 2027-04-30); Node 24 is active
LTS (EOL 2028-04-30). CI already tests 24 and the release workflow already
builds on 24. Native dependencies ship Node-API `napi-v3` prebuilts, so a
runtime major move carries no ABI risk.

## Decision

**Node 24 is the supported floor.** `.nvmrc`, `engines.node`, the Volta pin,
the Docker base image, and `@types/node` all move to 24. Node 22 stays
compatible but is no longer shipped or typed against.

## Consequences

- Types and runtime agree again, and the shipped pin is one that still
  receives security patches.
- `engines.node: ">=24"` refuses Node 22 installs that used to work; operators
  must upgrade before the next release.
- Non-LTS majors (23, 25) are no longer admitted implicitly.
- The runtime boundary is unchanged: no authored Python, no Python-driven
  native build.
- The arm64 tokenizer prebuilt gap that blocks ADR 0001's arm64 deploy
  candidate is tracked in `plans/042-dependency-review-2026-11.md` (DRV-06),
  not solved here.

Long-form record: [`plans/adr/0011-node-24-floor.md`](../../plans/adr/0011-node-24-floor.md).
