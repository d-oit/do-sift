---
name: skill-distiller
description: distill a resolved non-trivial problem or a repeatedly firing sensor into an updated feedforward guide (AGENTS.md or a SKILL.md); use after a slice passes all sensors, after non-trivial error recovery, or when the same check fires 2+ times.
---

# skill-distiller

The steering loop: sensors fire → guides update → sensors fire less. Fix the
feedforward guide, not just the symptom (plan 009, ADR 0008).

## Triggers (act when)

1. A slice passes the `verification` signal set after non-trivial work.
2. Recovery from a non-trivial failure (type system, migration, provider,
   policy, harness).
3. A spike uncovered a constraint worth a durable rule.
4. The same sensor or misunderstanding fires 2+ times in a sprint.

## Procedure

1. Extract the trace — commands, diffs, and the resolution — from the
   plan-file evidence and `.do-harness/` receipts, not from memory.
2. Generalize: strip secrets and machine-specific paths; keep the structural
   fix.
3. Update the matching feedforward guide: an AGENTS.md section or the
   existing `SKILL.md`. Create a new `.agents/skills/<name>/SKILL.md` only
   if no guide covers the pattern — frontmatter `name` must equal the
   directory name, `description` ≥ 20 chars, and every `npm run X` it cites
   must exist in root package.json.
4. Validate: `npm run skills:check` must pass.

## Rules

- Never distill a fix that did not pass its computational sensors —
  hallucinations propagate.
- One pattern per skill; keep procedures imperative and short.
- If the guide that needs updating is an accepted ADR, write a new ADR
  instead of editing it (plans/README rule).
- If an upstream tool defect blocks the workflow, preserve the exact failing
  command and output, use the configured repository's issue channel, and keep
  the local workaround explicit; do not weaken a sensor to hide the defect.
