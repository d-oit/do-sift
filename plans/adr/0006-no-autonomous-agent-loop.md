# ADR 0006 — No autonomous agent loop; bounded synthesis

Status: accepted 2026-09-06

## Context

Agentic autonomy (model-driven browsing, tool loops, self-repair) multiplies
token cost, latency, and failure modes, and undermines citation discipline.

## Decision

The synthesis model receives selected evidence passages only — no tools, no
browsing, no command execution. Search mode makes zero LLM calls; answer mode
makes exactly one bounded call (~4k input / ~700 output tokens). Failed or
invalid synthesis degrades to evidence-only output; there is no automatic
repair or model-fallback loop after a billable attempt. Budgets are reserved
atomically before external calls and reconciled against reported usage.

## Consequences

- Cost is predictable and measurable per request.
- "Self-learning" is operational (recorded outcomes, shadow policies,
  promotion gates) and never the model acting on its own outputs as evidence.
- Conversational follow-ups carry bounded recent context only; no full-thread
  replay.
