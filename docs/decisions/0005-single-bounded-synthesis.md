# 0005 — Exactly one bounded synthesis call

Status: accepted (first recorded 2026-09-06 in `plans/adr/0006-no-autonomous-agent-loop.md`)

## Context

Agentic autonomy — model-driven browsing, tool loops, self-repair — multiplies
token cost, latency, and failure modes, and it undermines citation discipline:
a model that can fetch its own sources can cite something the citation
validator never saw.

## Decision

The synthesis model receives selected evidence passages only. No tools, no
browsing, no command execution, no follow-up call. Answer mode makes **one**
call with a bounded input (~4k tokens) and output (~700 tokens).

- Budget is **reserved atomically in `usage_ledger` before** the call and
  reconciled against reported usage after it.
- A failed or invalid synthesis **degrades to evidence-only output**. There is
  no automatic repair, no second attempt, and no model-fallback chain after a
  billable failure.
- An empty evidence set short-circuits before any call.

## Consequences

- Cost per answer is predictable and bounded, and the ledger shows what was
  actually spent.
- A provider outage degrades honestly: the user gets the evidence and a
  reason, not a retry storm.
- The answer cache is safe to key on owner + question + mode + source
  versions, because the same inputs produce the same single-shot request.
- Cost: no self-correction. A malformed structured response is a degraded
  answer, not a retried one. Provider adapters therefore validate the shape
  strictly on the first response.
