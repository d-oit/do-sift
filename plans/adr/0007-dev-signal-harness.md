# ADR 0007 — First-party dev signal harness; do-harness as concept

Status: accepted 2026-09-13

## Context

The owner asked for d-o-hub/do-harness — a Rust CLI agent-execution harness
("feedforward guides plus computational sensors") — to be implemented as this
repo's dev signal harness, built by a swarm of agents with an orchestrator.
Plan 000 decision D10 already designates d-o-hub repos (do-harness included)
as **concept references only**, and ADR 0004 set the same precedent for
deepseek-harness: adopt the concept, never the dependency. Concretely,
do-harness is tagged `wip-do-not-use`, requires Rust 1.85+, and its
distill/eval path shells out to a Python tool — all three collide with
existing accepted decisions (D10, D1).

## Decision

Build a **first-party TypeScript dev signal harness** at
`packages/dev-harness/` (workspace dev tooling, **not** a product plugin: no
kernel capabilities, no manifest, no LLM calls), porting do-harness's concepts:

- **Sensors** mapped to this repo's own check pipeline steps (prettier,
  eslint, typecheck, policy, skills, tests, evals, release-check), executed
  with the same no-shell `spawnSync(process.execPath, …)` pattern as
  `scripts/check.ts`.
- **Named signal sets** `feedback` / `verification` / `release` (upstream
  parity).
- **Exit codes** 0 pass / 1 sensor failure / 2 usage-config-state error
  (upstream parity). An empty or unknown set is a usage error, never a
  vacuous pass (INV-006 spirit).
- **Strike/halt**: 3 consecutive failing runs of one sensor halt it (it is
  skipped and reported failed with a halt diagnostic) until an explicit
  `errors clear`; a passing run resets the streak (upstream README parity).
- **Append-only, hash-chained workflow event log** at
  `.do-harness/events.jsonl` (upstream's `workflow_events` with
  `seq`/`chain_hash`, as JSONL instead of libSQL).
- **Evidence receipts** per run: `.do-harness/evidence.<set>.json` with
  per-sensor exit codes, durations, output SHA-256 and truncated output tail.
- **Git hooks** as version-controlled `.githooks/` scripts activated via
  `git config core.hooksPath .githooks` (`hook install`): pre-commit runs the
  feedback set, pre-push the verification set (upstream wiring, minus the
  fragile build-into-`target/` binary pattern).
- The agent-facing surface is a `dev-signals` skill (run/status guidance),
  mirroring upstream's single typed `development_signals` tool concept — with
  **zero LLM integration** (token discipline).

## Consequences

- The development loop produces computational receipts, extending "research
  with receipts" to development time; task handoffs can cite dev-signal
  status instead of unverified claims.
- Deviations from upstream, recorded: no libSQL state DB (JSONL log suffices
  at dev scale; product storage stays owner-scoped per ADR 0002); no
  task/trace/distill/eval/compliance commands (task tracking is owned by
  `plans/0NN-*.md` per AGENTS.md; distill/eval are Python-dependent; upstream
  compliance mapping is out of scope); no workspace-fingerprint staleness
  detection (deferred); the local Rust toolchain is intentionally unused.
- `harness` in `packages/contracts` (research/browser/computer task runs)
  remains a distinct, product-side concern; this ADR covers development-time
  tooling only.
