# plans/ — decision records, task plans, invariants

This folder is the project's memory. Agents and humans update it together.

## Layout

- `0NN-*.md` — numbered milestone plans with task tables (one row per task ID)
- `invariants.json` — machine-checked invariants; each maps to an enforcing
  test or script (CI fails if an invariant has no enforcing check)
- `risks.md` — living risk register with owners and status
- `sources.md` — dated records of commercial limits, quotas, and terms
  (Turso tiers, search/model providers). Every provider activation gate
  requires a fresh entry here.
- `adr/` — architecture decision records (immutable once accepted)
- `templates/task.md` — task record format

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
