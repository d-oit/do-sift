# ADR 0004 — Own minimal plugin kernel; deepseek-harness as concept

Status: accepted 2026-09-06 (spike FND-10 may append a follow-up)

## Context

The owner asked for an everything-is-a-plugin architecture "like
deepseek-harness" (dsh). dsh is a TypeScript/Cordis harness with a huge
adoption but is an explicitly developer-preview project announcing
compatibility-breaking changes, and it vendors a `python/` tree — in tension
with ADR 0001 if adopted wholesale.

## Decision

We build a **minimal first-party kernel** (`packages/kernel`): manifest
validation, lifecycle (`activate`/`deactivate`), capability/permission model
with explicit grants, and a local registry. dsh/Cordis is a concept
reference. Adoption of Cordis or dsh as a dependency is permitted only via a
spike (FND-10) that demonstrates concrete benefit over the first-party kernel
without reintroducing a Python runtime requirement or preview-churn risk;
the outcome is recorded as an addendum here.

## Consequences

- Kernel stays tiny; contracts live in `packages/contracts` (the only shared
  dependency); all features — including the research pipeline itself — are
  plugins.
- Plugins declaring `paid` or `computer` capabilities require recorded,
  explicit grants and stay disabled in CI (INV-003).
- Plugin code is loaded through the kernel's capability-checked services,
  not granted raw `fs`/`net`. Isolated-runtime hardening is a later
  evaluation (risk R-04), tracked in the risk register.
