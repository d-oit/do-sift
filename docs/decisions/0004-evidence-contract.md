# 0004 — Evidence is stored with provenance before any merge

Status: accepted (first recorded 2026-09-06 in `plans/adr/0003-evidence-contract.md`)

## Context

If the engine stores a synthesized answer and reconstructs its sources later,
it cannot prove the sources said what the answer claims. Merging, deduping, or
summarizing before storage destroys exactly the detail a citation needs:
which URL, which passage, when it was fetched, what it hashed to.

## Decision

Every fetched source is stored **as evidence, with provenance, before any
merge or aggregation**:

- `documents` — canonical URL, original URL, content hash, fetch time,
  published time when the source states one.
- `passages` — the extracted excerpt, its heading, extraction status, and an
  optional noise class.
- Answers reference passage ids. `validateCitations` checks each cited id
  against the stored set for that run; an invalid citation degrades the answer
  to evidence-only output, with no repair loop.

Merging happens at read time, and never rewrites the stored rows.

## Consequences

- A citation is verifiable after the fact: the answer's claim can be checked
  against the exact passage text that was stored.
- `publishedAt` stays unset when a provider does not state one. Honesty over
  field-filling is a rule, not a preference.
- Storage is append-mostly; retention is an explicit, audited operation
  (`retention prune`, dry-run unless confirmed).
- Cache keys include the source versions, so an answer is never served
  against evidence that has since changed.
- Cost: more rows than a summary-only design, and extraction quality shows up
  in retrieval quality rather than being hidden by a summary.
