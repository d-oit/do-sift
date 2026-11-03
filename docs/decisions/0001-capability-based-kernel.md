# 0001 — A capability-based kernel, not a plugin free-for-all

Status: accepted (first recorded 2026-09-06 in `plans/adr/0004-own-kernel-vs-dsh.md`)

## Context

do-sift loads third-party-shaped code — search adapters, model adapters,
browser and computer harnesses, storage backends — into one process that
holds credentials and a database. A plugin that can import `node:net` or
`node:fs` can read the database, exfiltrate an API key, or reach a private
network address regardless of what the caller intended. Configuration cannot
express those boundaries; only the loading mechanism can.

## Decision

Every feature is a plugin, and the kernel is the gate:

- A plugin ships a `plugin.json` manifest declaring `capabilities` and
  `permissions` (network hosts, secret names).
- The kernel validates the manifest before any plugin code loads.
- The kernel refuses activation when a declared capability was not granted.
  `paid` and `computer` capabilities additionally require an explicit
  recorded grant and stay disabled in CI.
- Plugins receive **capability-checked services** on their context —
  `context.network.assertHostAllowed`, `context.secrets.resolve`,
  `context.events`, `context.guardrails` — never raw `fs`/`net`. Plugins that
  import the modules directly are rejected by the `pluginImports` policy
  check.

## Consequences

- The boundary is enforceable and testable: `packages/kernel/test/kernel.test.ts`
  proves an ungranted `paid` or `computer` plugin cannot activate (INV-003),
  and `scripts/policy.ts` proves plugin source cannot reach raw Node modules.
- Every new capability is a deliberate, reviewable change to the contract
  surface rather than a dependency a plugin adds on its own.
- A plugin cannot self-serve a network host: the manifest's `networkHosts`
  is what `assertHostAllowed` enforces, so adding a host is a visible diff.
- Cost: a plugin author writes a manifest and learns the context services.
  The [contributor guide](../contributing-guide.md) is that walkthrough.
- We do not get an isolated runtime from this (risk R-04). Capability checks
  gate what we hand a plugin; they do not sandbox a plugin that misbehaves
  after activation.
