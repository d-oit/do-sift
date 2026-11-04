# Decision records

Short, readable records of the choices that shape do-sift. Each answers
_what we decided_, _why_, and _what it costs us_. They restate decisions whose
long-form records live in the repository's `plans/adr/` directory; where the
two differ, `plans/adr/` is authoritative and this index is out of date.

| Record                                      | Decision                                                    | Long-form source                               |
| ------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| [0001](0001-capability-based-kernel.md)     | Everything is a plugin behind a capability-based kernel     | `plans/adr/0004-own-kernel-vs-dsh.md`          |
| [0002](0002-libsql-storage.md)              | libSQL (Turso) for durable storage                          | `plans/adr/0002-libsql-and-storage.md`         |
| [0003](0003-zero-llm-search.md)             | Search mode makes zero LLM calls                            | `plans/000-product-and-decisions.md` (D5)      |
| [0004](0004-evidence-contract.md)           | Evidence is stored with provenance before any merge         | `plans/adr/0003-evidence-contract.md`          |
| [0005](0005-single-bounded-synthesis.md)    | Answer mode makes exactly one bounded synthesis call        | `plans/adr/0006-no-autonomous-agent-loop.md`   |
| [0006](0006-hybrid-retrieval.md)            | bm25 first; local embeddings only if they beat the baseline | `plans/adr/0009-fastembed-hybrid-retrieval.md` |
| [0007](0007-browser-automation-boundary.md) | Browser automation is policy-gated and non-stealth          | `plans/adr/0005-browser-ethics-boundary.md`    |
| [0008](0008-node-only-no-python.md)         | TypeScript/Node only; no authored Python                    | `plans/adr/0001-typescript-node.md`            |
| [0009](0009-plugin-lifecycle.md)            | Plugins have an explicit activate/deactivate lifecycle      | `plans/adr/0004-own-kernel-vs-dsh.md`          |
| [0010](0010-dev-signal-harness.md)          | Checks run as receipt-producing sensors                     | `plans/adr/0007-dev-signal-harness.md`         |

## Status vocabulary

- **Accepted** — the decision holds and code enforces or assumes it.
- **Superseded** — replaced by a later record, which is named.
- **Proposed** — written down, not yet relied on by code.

Every record here is **accepted**. A superseded record stays in place and
links forward; we do not rewrite history in place.

## Adding a record

1. Copy the shape of an existing record: title, status, context, decision,
   consequences.
2. Number it one past the highest number in this directory.
3. Add it to the table above.
4. If the decision came from a `plans/` record, link that source so the two
   can be compared.
5. `npm run check:fast` runs the link checker; a record that is not linked
   from this index is invisible, so add the row in the same change.
