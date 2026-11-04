# 0003 — Search mode makes zero LLM calls

Status: accepted (decision D5 in `plans/000-product-and-decisions.md`)

## Context

A web research engine can easily become a model loop: rewrite the query,
summarize each page, decide what to fetch next. Every one of those steps is a
billable, non-deterministic call whose output is hard to audit. The product's
claim is "research with receipts": whatever the engine says must trace to
stored evidence. A model in the search path produces summaries that are not
evidence, and costs money on the runs that are supposed to be free.

## Decision

**Search mode makes zero LLM calls.** It is a deterministic pipeline: query
the search providers, fetch pages through the safe-fetch guard, extract
passages, store them with provenance. **Answer mode makes exactly one bounded
call** ([0005](0005-single-bounded-synthesis.md)).

The guarantee is structural, not an optimization: the search runtime is
composed without a model provider, so there is no object to call.

## Consequences

- A search run cannot spend money. Provider quota is the only external cost,
  and provider failures degrade to the surviving provider with a recorded
  reason rather than to a model fallback.
- Search output is reproducible for a fixed corpus; the retrieval evaluation
  can be a baseline comparison rather than a sampling exercise.
- Answer quality depends on retrieval and prompting, not on a search-time
  model's judgement. When retrieval is weak, the honest output is
  evidence-only, and that is what the pipeline returns.
- A research-only deployment can omit the model entirely; `createRuntime`
  accepts no model and the answer route refuses rather than improvising.
- Cost: no query rewriting. A badly phrased question retrieves badly. The
  mitigation is provider diversity and hybrid retrieval, not a model.
