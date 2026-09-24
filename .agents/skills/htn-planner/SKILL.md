---
name: htn-planner
description: decompose a coding objective into ordered subtasks with preconditions before touching code — vertical slice vs spike; use when planning compound tasks, splitting features into subtasks, or choosing between a slice and a spike.
---

# htn-planner

Turn an objective into a deterministic, sensor-gated decomposition. Each
subtask completes only when a computational check exits 0 — never on
self-assessment (plan 009, ADR 0008: do-harness engineering model).

## Method catalog

### Vertical slice (default)

Preconditions: the objective has a task row in a `plans/0NN-*.md` plan with
acceptance criteria, the contracts/invariants it touches are known, and (when
using upstream tasks) `plans/methods.json` names sensors that actually exist
in `do-harness.toml`.

1. Record the ordered subtask list in the task row (or a new plan) before
   writing code. Keep one owner and one vertical outcome per row.
2. Write or adjust the failing test that defines "done" for the first
   subtask (red).
3. Implement the smallest slice that turns it green
   (`implement-slice` skill); do not refactor adjacent code.
4. Run `npm run signals -- verify --set feedback`; a subtask pointer may
   advance only on exit code 0. With upstream `do-harness`, use the numeric
   task ID returned by `task add` and run task-scoped `verify --record`.
5. Before handoff run the `verification` set, record a trace for non-trivial
   recovery, and record evidence (commands + results) in the plan file.

### Spike & resolve

Preconditions: high uncertainty about a third-party API, provider limits,
costs, or performance — decided at planning time, never discovered
mid-implementation.

1. Route the uncertain subtask to the `spike-runner` skill before any
   production code.
2. Fold the resolved approach back into a vertical slice.

## Rules

- Never advance a subtask pointer until its sensor check exits 0.
- Never decompose a task that has no plan row or acceptance criteria — get
  the plan first.
- If preconditions for both methods are unmet, stop and report instead of
  improvising (AGENTS.md stop conditions).
