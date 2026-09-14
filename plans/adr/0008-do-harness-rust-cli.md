# ADR 0008 — Upstream do-harness Rust CLI adopted for the dev loop

Status: accepted 2026-09-13 (owner instruction)

## Context

Plan 008 / ADR 0007 ported do-harness's concepts first-party
(`scripts/dev-harness`, relocated out of `packages/` per plan 009 DHC-01) and
excluded the upstream binary — do-harness is tagged `wip-do-not-use`, needs
Rust 1.85+, and its eval/distill path shells out to Python. On 2026-09-13 the
owner directed: "use the rust cli do-harness with agents skills and agents.md
concept usage" — the real CLI should run in this repo's coding workflow, not
only its concepts. An accepted ADR is immutable, so this record supersedes
that one consequence of ADR 0007 instead of editing it.

## Decision

- Adopt the upstream **Rust `do-harness` CLI** as the agent-facing dev-loop
  harness. Installed per machine via `cargo install --git
https://github.com/d-o-hub/do-harness do-harness` (never built into this
  repo; no product or CI dependency — contributors without Rust keep the
  first-party path).
- Root `do-harness.toml` registers **this repo's own check pipeline** as
  sensors (direct node entrypoints, same steps as `scripts/check.ts` and the
  first-party registry), with signal sets `feedback` / `verification` /
  `release` mirroring `scripts/dev-harness/sensors.ts`. `language =
"generic"` — no upstream Rust-pack sensors.
- **The first-party TS CLI stays the enforced path.** Git hooks
  (`.githooks/`, `core.hooksPath`) and any CI keep calling `npm run signals`;
  upstream `hook install` is NOT run here (it would fight
  `core.hooksPath .githooks` and add a Rust requirement to every commit).
  The two runners execute the same sensors; agents with the toolchain may
  use `do-harness verify` / `status` / `doctor` directly.
- **Skills:** the upstream harness usage skill is adopted in adapted form
  alongside the methodology skills ported in plan 009 DHC-02 (`htn-planner`,
  `spike-runner`, `skill-distiller`), all rewritten for do-sift (npm signals,
  plan-file persistence, gitignored `.spikes/`). Upstream's
  `event-modeler` / `fail-closed-proxy` (Rust-internals) and `pr-triage`
  remain not ported.
- **Still excluded (unchanged from ADR 0007):** upstream's Python-dependent
  eval/distill path (AGENTS.md ground rule 1: no Python), the
  `guardian-proxy` sidecar, libSQL as product storage, and any LLM
  integration in the dev loop (token discipline).

## Consequences

- Two runners over the same sensors: `do-harness verify` (Rust, upstream
  semantics: strikes, evidence, exit codes 0/1/2) and `npm run signals` (TS,
  hash-chained JSONL receipts). State files coexist under the gitignored
  `.do-harness/` directory (`agent_state.db` vs `events.jsonl` /
  `evidence.<set>.json`); neither reads the other.
- Upstream is wip and may change or break; the TS path guarantees the
  enforced checks keep running. If the Rust build fails on a platform, that
  is a per-machine tooling issue, never a check failure.
- Concept-only adoption (Plan 000 D10) still governs PRODUCT code; this ADR
  covers development-time tooling only, like ADR 0007.
