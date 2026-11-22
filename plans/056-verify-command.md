# Plan 056 — Canonical verify command (issue #180, slice 1)

Status: in-progress. Owner: maintainer.

Slice 1 is orchestration-only and changes no workflow: add documented
`verify:fast` / `verify` entry points that reuse existing scripts, and point
contributor/agent guidance at them. No `.github/workflows` edits, no CI job
changes, no duplicated check implementations.

## Task IDs

| ID     | Task                                                               | Status      | Evidence                                                                                |
| ------ | ------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------- |
| VER-01 | Add `verify:fast` (`check:fast`) and `verify` (`check` + coverage) | done        | `npm run verify:fast` PASS 9/9; `npm run verify` PASS (check + coverage 1014+124 tests) |
| VER-02 | Document canonical command, CI-only extras, runtime, cleanup       | done        | Contributing guide setup + handoff sections; AGENTS.md approved commands                |
| VER-03 | Full green: PR CI incl. Codacy, then merge                         | in-progress | Awaiting PR checks                                                                      |

## Scope notes (issue #180)

- `verify:fast` reuses `check:fast` (9 deterministic offline steps).
- `verify` reuses `check` (fast + tests + evals + build) then
  `test:coverage`. Stages chain with `&&` so the first failure stops the run
  with a non-zero exit; no paid key or live provider is required.
- CI-only extras, documented in the contributor guide rather than claimed as
  local: `evals:dashboard` (regenerates tracked `evals/dashboard/index.html`)
  and the `container` build+smoke (needs Docker).
- Open gap for a later slice (needs owner approval as a workflow change):
  CI's `check` job also runs `evals:dashboard`; wiring the workflows to call
  `verify` directly is deliberately not done here.
