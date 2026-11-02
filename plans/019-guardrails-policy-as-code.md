# Plan 019 — Ethical guardrails as code (issue #124)

Status: done (2026-11-02)

Source: [issue #124](https://github.com/d-oit/do-sift/issues/124) — "Formalize
the Ethical Guardrails Policy as Code". The enforcement lived inside plugin
code (browser/computer harnesses) and the shipped deny list, which made the
policy hard to audit, version, or extend without reading TypeScript.

## Decisions

- **Format:** a standalone declarative JSON document
  (`packages/contracts/src/guardrails.json`) evaluated by a typed, pure
  evaluator (`packages/contracts/src/guardrails.ts`). This is the issue's
  ".rego or equivalent": it externalizes the rules, keeps default-deny
  semantics, and stays inside the Node-only, hermetic check pipeline
  (ADR 0001). Running an OPA binary would add a Go toolchain and require a
  `.github/workflows` change, which AGENTS.md lists as an approval boundary.
  `docs/guardrails.md` records the parity path if OPA is adopted later.
- **Two-sided safety:** widening (new sites, new prohibited classes, narrowed
  action allowlists) is a data edit; _weakening_ (dropping a shipped
  default-deny site, un-gating browser/computer grants, dropping computer
  consent or browser site access, emptying a prohibited class) throws in
  `assertGuardrailsIntegrity` and therefore needs an ADR.
- **Kernel as the single entry point:** the kernel validates the policy at
  construction and injects `context.guardrails`, scoped to the automation
  capabilities the plugin declared. Both harnesses consult it for every
  action; direct construction in tests falls back to the shipped policy.
- **INV-007 check untouched:** `scripts/policy.ts` is an approval-boundary
  file, so `DEFAULT_DENY_SITES` stays the literal source it scans, and
  `tests/security/guardrails.test.ts` fails if the policy document diverges.

## Tasks

| ID     | Task                                                               | Status |
| ------ | ------------------------------------------------------------------ | ------ |
| GRD-01 | Standalone declarative guardrails policy document                  | done   |
| GRD-02 | Typed schema, evaluator, and integrity floor in contracts          | done   |
| GRD-03 | Kernel validates the policy and injects `context.guardrails`       | done   |
| GRD-04 | Browser/computer harnesses consult the engine per action           | done   |
| GRD-05 | Policy tests in the check pipeline + "How to Extend" documentation | done   |

## Evidence (2026-11-02)

Files changed:

- `packages/contracts/src/guardrails.json` (new) — policy document
- `packages/contracts/src/guardrails.ts` (new) — schema/evaluator/integrity
- `packages/contracts/src/index.ts` — export
- `packages/contracts/tsconfig.json` — include `src/**/*.json` so `tsc -b`
  can type the JSON import
- `packages/kernel/src/kernel.ts` — `KernelOptions.guardrails`,
  `PluginContext.guardrails`, activation gate, scoped engine
- `packages/plugins/plugin-harness-browser/src/index.ts` — per-action gate
- `packages/plugins/plugin-harness-computer/src/index.ts` — per-action gate
- `tests/security/guardrails.test.ts` (new) — 19 policy/wiring tests
- `docs/guardrails.md` (new) — includes "How to Extend the Guardrails"
- `plans/019-guardrails-policy-as-code.md`, `plans/README.md`, `CHANGELOG.md`

Commands run:

- `npx vitest run` → 73 files, 758 tests, all pass.
- `npm run check` → 9/9 steps PASS (prettier, eslint, typecheck, policy,
  skills, governance, tests, evals, build).
- `npm run check:fast` (after the plan/changelog edits) → 6/6 steps PASS
  (prettier, eslint, typecheck, policy, skills, governance).
- `npm run build` emits `packages/contracts/dist/guardrails.json`, so the
  compiled package ships the policy document with the engine.

Acceptance criteria mapping:

1. Standalone policy file → `packages/contracts/src/guardrails.json`
   (`.rego or equivalent`; rationale recorded above).
2. Kernel consults the engine for every browser/computer action →
   `context.guardrails` + per-action gates in both harnesses, covered by
   `tests/security/guardrails.test.ts` ("harnesses consult the engine for
   every action").
3. Policy tests in the check pipeline → `tests` step of `npm run check`.
4. "How to Extend the Guardrails" → `docs/guardrails.md`.

## Risks / open questions

- The deny list is stated twice (policy document + `DEFAULT_DENY_SITES`) for
  the reason above; the sync test is the mitigation. Folding `policy.ts`'s
  INV-007 scan to the policy document would remove the duplication but needs
  approval for that file.
- OPA itself is not used; `opa test` parity is documented, not implemented.
- Kernel-level consent is asserted by the computer harness after its ledger
  decision; a future non-harness caller must assert consent explicitly or be
  denied (`consent-required`).

**Next suggested task:** extend the registry/guardrails with site entries
from `plans/sources.md` terms checks, or migrate the INV-007 scan to the
policy document once `scripts/policy.ts` changes are approved.
