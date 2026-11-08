# Plan 039 — Rego export for the ethical guardrails (issue #124)

Status: in review (PR #138, rebased onto main past #135).

## Context

Issue #124 asked for the guardrails "as code (OPA/Rego)". Plan 019 (on
main) externalized the policy as `packages/contracts/src/guardrails.json`
with a typed evaluator, per-action harness consults, and 19 policy/wiring
tests — and explicitly deferred OPA execution (Node-only pipeline, ADR
0001). The JSON-only closure left no machine-readable Rego for auditors
and OPA consumers. Issues #121 (docs hub + link gate), #122 (MCP server,
ADR 0010), and #123 (owner-gated integrations, plan 038) are implemented
on main via #135; this branch rebases onto that work and re-verifies it.

## Tasks

| ID     | Task                                                         | Status |
| ------ | ------------------------------------------------------------ | ------ |
| REG-01 | `policies/guardrails.rego` mirrors guardrails.json v1        | done   |
| REG-02 | `scripts/guardrails-check.ts` sync gate in `check:fast`      | done   |
| REG-03 | `docs/guardrails.md` Rego section + decision record 0011     | done   |
| VER-01 | Rebase onto main (past #135/#136/#137), resolve in its favor | done   |
| VER-02 | Full `npm run check` + CI green, then merge                  | open   |

## Decisions

- Execution stays TypeScript; the Rego is an export, not a second
  enforcer — no OPA binary, no `.github/workflows` change (ADR 0001,
  approval boundary).
- Sync is one-directional and literal: every site/action/gate in the JSON
  must appear quoted in the Rego. `guardrails.json` remains the single
  source of truth; `assertGuardrailsIntegrity` still guards weakening.

## Risks

- #123 live paths stay owner-blocked (EXT-G1/EXT-G2 in plan 038: no api2
  key — programme closed 2026-09-21 — no paid spend without approval).
- Codacy posts no GitHub check on this repo; the diff is kept
  duplication-free and covered by the pipeline instead.
