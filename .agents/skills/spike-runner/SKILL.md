---
name: spike-runner
description: run a throwaway de-risking spike for an uncertain third-party API, provider limit, or performance question; use when a plan task is highly uncertain, decomposition surfaces an ambiguity, or a minimal prototype must pass before implementing.
---

# spike-runner

A spike produces knowledge, not production code. Isolate and resolve the
uncertainty before committing to a vertical slice (plan 009, ADR 0008).

## When to spike

- Uncertain third-party/provider API behavior or error semantics.
- Unknown performance or cost limits (record findings in `plans/sources.md`
  when commercial terms are involved).
- A novel pattern that needs validation before it enters a slice.
- `htn-planner` decomposition flagged the subtask as uncertain.

## Procedure

1. State the hypothesis and the single uncertain thing in the task's plan
   row before writing any code.
2. Prototype only that uncertainty in the gitignored `.spikes/` directory
   (or the OS temp dir) — never in `packages/`, `scripts/`, `apps/`, or
   `evals/`.
3. Success is an automated exit code 0 from a command that proves or
   disproves the hypothesis — not a reading of the output by feel.
4. Record findings (what worked, what failed, chosen approach, error
   signatures) as evidence in the plan file; add durable caveats to
   `plans/risks.md`.
5. Delete the scratch files; spike code never leaks into a slice. Hand the
   resolved approach back to `htn-planner` / `implement-slice`.

## Rules

- A spike is never a partial implementation.
- Fail-fast: after 3 consecutive failed attempts on the same question, halt,
  record the error signature, and report instead of guessing (AGENTS.md stop
  conditions).
- Never run spike experiments against paid APIs or owner data without the
  approvals AGENTS.md requires.
