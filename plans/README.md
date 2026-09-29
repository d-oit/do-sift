# plans/ — decision records, task plans, invariants

This folder is the project's memory. Agents and humans update it together.

## Layout

- `0NN-*.md` — numbered milestone plans with task tables (one row per task ID)
- `methods.json` — do-harness task-method catalog; subtask gates reference
  this repository's configured sensor names
- `invariants.json` — machine-checked invariants; each maps to an enforcing
  test or script (CI fails if an invariant has no enforcing check)
- `risks.md` — living risk register with owners and status
- `sources.md` — dated records of commercial limits, quotas, and terms
  (Turso tiers, search/model providers). Every provider activation gate
  requires a fresh entry here.
- `adr/` — architecture decision records (immutable once accepted)
- `templates/task.md` — task record format

## Current queue

- `013-ans-evidence-hardening.md` — finish ANS-11 → ANS-13 before any live model activation.
- `014-production-usage.md` — OPS-07, OPS-08, and OPS-09 are done; OPS-10 reverse-proxy profile is next.
- `015-workflow-compaction.md` — DHC-05 is done; DHC-06 upstream issue publication is blocked by GitHub token scope.

Older milestone plans remain as historical evidence. Their detailed task
records and stable IDs are retained; use this queue rather than stale
"next suggested task" notes to choose new work.

## Task lifecycle

`proposed` → `ready` → `in-progress` → `done` (or `blocked`).

A task moves to `done` only when its acceptance evidence is recorded in the
plan file: commands, outputs, and remaining risks. "Tests pass" without a
command record is not evidence.

## Rules

1. Plans are append-friendly: prefer new ADRs over editing accepted ones.
2. Every invariant must have an enforcing check; `scripts/policy.ts`
   validates this mapping.
3. Commercial facts (prices, quotas, terms) expire — record the checked date.
4. Task IDs are stable forever; never reuse or renumber them.
