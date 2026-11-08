# 0011 — Guardrails ship an OPA-readable Rego export

Status: accepted (issue #124 follow-up; source: `plans/039-rego-guardrails-export.md`)

## Context

The guardrails are a JSON data document evaluated by a typed engine
([0007](0007-browser-automation-boundary.md), `plans/adr/0005`). Issue #124
asked for the policy "as code (OPA/Rego)". Running an OPA binary would break
the Node-only, hermetic pipeline (ADR 0001), so the executable path stays
TypeScript — but auditors and OPA consumers had no machine-readable Rego to
load.

## Decision

Ship `policies/guardrails.rego`: a Rego mirror of
`packages/contracts/src/guardrails.json` (same default-deny decision, same
prohibited classes, same deny list, same per-capability gates). Execution
stays in the TypeScript evaluator; the Rego is an export, not a second
enforcer. `scripts/guardrails-check.ts` runs in `npm run check:fast` and
fails when any site, action, or gate in the JSON is missing from the Rego,
so the two cannot drift.

## Consequences

- OPA tooling can load the shipped rules as a `data` document today; `opa
test` parity remains future work, not a pipeline dependency.
- A policy edit must touch the Rego in the same change — the sync gate
  enforces it.
- If OPA execution is ever adopted, this file is the starting point, and the
  adoption itself needs a new record.
