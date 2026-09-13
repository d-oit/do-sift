# Plan 000 — Product and decisions

Status: accepted (2026-09-06)

## Product

do-sift is a source-first web research and answer engine. Users ask questions;
the engine searches, fetches, extracts, and stores evidence, then answers with
validated citations — or returns evidence-only results when no model call is
warranted or available. Tagline: "research with receipts."

## Non-goals (v0)

- No autonomous broad crawler; no graph database; no multi-agent runtime.
- No fine-tuning. No LLM planner/rewriter/reranker in the default path.
- No semantic answer-cache reuse in v0 (similarity may retrieve evidence,
  never silently reuse a completed answer).
- No public multi-user deployment before the OPS/QUAL gates.

## Core decisions

| #   | Decision                                                                                                                                               | Record       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| D1  | TypeScript/Node only; no authored Python, no Python runtime                                                                                            | ADR 0001     |
| D2  | Everything-is-a-plugin architecture, own minimal kernel; deepseek-harness adopted as concept, not dependency (spike gate: FND-08)                      | ADR 0004     |
| D3  | Turso libSQL for durable storage; local libSQL file for dev/tests                                                                                      | ADR 0002     |
| D4  | Evidence contract with per-source provenance stored **before** any merge/aggregation                                                                   | ADR 0003     |
| D5  | Search mode = 0 LLM calls; answer mode = 1 bounded call (~4k in / ~700 out)                                                                            | Plan 003/004 |
| D6  | Browser automation is policy-gated, human-paced, non-stealth; bot-prohibiting sites (LinkedIn) default-deny                                            | ADR 0005     |
| D7  | Computer automation local-only, consent-gated, default-off                                                                                             | ADR 0005     |
| D8  | No autonomous agent loop: model gets evidence only, no tools                                                                                           | ADR 0006     |
| D9  | Free-first: paid calls require opt-in + verified price metadata in `sources.md`                                                                        | `sources.md` |
| D10 | d-o-hub / d-o-it repos (do-harness, rust-self-learning-memory, chaotic_semantic_memory, do-web-doc-resolver) and LadybugDB are concept references only | risks.md     |

## Token/cost policy

- Exact-answer cache keyed on owner, normalized question, mode, source
  versions, freshness, policy/prompt/model revision.
- Budgets reserved atomically before external calls (`usage_ledger`).
- Daily caps even on free tiers; honest degraded modes when quotas exhaust.

## Milestones

FND → CORE → SRC → ANS → BRW → CMP → RET/LRN → OPS → QUAL.
See `001`–`007` for detail. Exit gates are listed per milestone and enforced
via `plans/invariants.json`.
