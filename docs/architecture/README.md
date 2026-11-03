# Architecture

How do-sift is put together, and why. This index links the readable design
documents; the decision records behind each choice are in
[`../decisions/`](../decisions/README.md).

## The one-paragraph version

A request enters through the HTTP server or CLI. An authenticated principal
names a tenant; a tenant-bound runtime owns that tenant's repositories, budget
ledger, and job queue. **Search mode** runs a zero-LLM pipeline: query the
search providers, fetch pages through the safe-fetch guard, extract passages,
store evidence with provenance. **Answer mode** retrieves passages, makes
exactly one bounded synthesis call, and validates every citation against
stored evidence — an invalid citation degrades to evidence-only output rather
than a repair loop. Everything that touches the outside world is a plugin
with declared capabilities, and the kernel refuses to activate one whose
capabilities were not granted.

## Pieces

| Area          | Where                                       | Responsibility                                                                       | Design notes                                                                                                   |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Kernel        | `packages/kernel`                           | Manifest validation, lifecycle, capability grants, guardrail injection               | [ADR-0001](../decisions/0001-capability-based-kernel.md), [ADR-0009](../decisions/0009-plugin-lifecycle.md)    |
| Contracts     | `packages/contracts`                        | Zod schemas shared by every boundary: evidence, models, search, auth, guardrails     | [ADR-0004](../decisions/0004-evidence-contract.md)                                                             |
| Storage       | `packages/storage`, `migrations/`           | libSQL repositories, budget ledger, job queue, retention, tenant scoping             | [ADR-0002](../decisions/0002-libsql-storage.md), [multi-tenant-auth.md](../multi-tenant-auth.md)               |
| Retrieval     | `packages/storage/src/retrieval.ts`         | bm25 baseline plus optional hybrid vector fusion                                     | [ADR-0006](../decisions/0006-hybrid-retrieval.md)                                                              |
| Server        | `packages/server`, `apps/server`            | HTTP routes, per-principal runtimes, answer service, read surface                    | [api.md](../api.md), [ADR-0003](../decisions/0003-zero-llm-search.md)                                          |
| MCP bridge    | `packages/server/src/mcp.ts`, `apps/mcp`    | The same runtime over Model Context Protocol stdio, for Python and other clients     | [api.md](../api.md#model-context-protocol-mcp-surface), [ADR 0010](../../plans/adr/0010-python-interop-mcp.md) |
| Plugins       | `packages/plugins/*`                        | Search providers, model adapters, harnesses, extraction, storage, site-access policy | [contributing-guide.md](../contributing-guide.md)                                                              |
| Safe fetching | `packages/safe-fetch`                       | Scheme/IP/redirect/DNS/size/time/MIME guards in front of every outbound fetch        | [outbound-transport-inventory.md](../outbound-transport-inventory.md)                                          |
| Auth          | `packages/auth`, `plugins/plugin-auth-oidc` | Owner allowlist fallback and OIDC multi-tenant principals                            | [multi-tenant-auth.md](../multi-tenant-auth.md)                                                                |
| Guardrails    | `packages/contracts/src/guardrails.*`       | Declarative default-deny policy for browser/computer automation                      | [guardrails.md](../guardrails.md)                                                                              |

## Request lifecycles

**Search mode — zero LLM calls.** This is the product's token-frugality
guarantee ([ADR-0003](../decisions/0003-zero-llm-search.md)): a search run
cannot spend money because there is no model in the path.

1. Authenticate → principal (`tenantId`, `userId`) → tenant-bound runtime.
2. Search providers fan out; one provider failing degrades to the survivor and
   the degradation is recorded in the run summary
   (`packages/server/src/search-merge.ts`).
3. Each hit is fetched through `safe-fetch`, checked hop-by-hop against the
   site-access policy.
4. Passages are extracted and stored with provenance **before** any merge.
5. Embeddings and noise classes are backfilled for what was just stored,
   within the same tenant scope.

**Answer mode — exactly one bounded call.** See
[ADR-0005](../decisions/0005-single-bounded-synthesis.md).

1. Exact-answer cache lookup (owner + question + mode + source versions).
2. Retrieve passages (bm25, or hybrid when an embedder is configured).
3. Reserve budget in `usage_ledger` before the external call.
4. One `model.complete` call.
5. Validate citations against the stored evidence. Invalid → degraded,
   evidence-only output; never a second model call.
6. Settle the ledger with actual usage and store the answer.

## Where to go next

- Adding a plugin: [contributing-guide.md](../contributing-guide.md)
- Running it: [deployment.md](../deployment.md)
- The API: [api.md](../api.md)
- Why any of it is this way: [decisions/](../decisions/README.md)
