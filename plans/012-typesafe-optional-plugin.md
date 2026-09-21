# Plan 012 — TypeSafe System One, optional plugin only

Status: proposed (2026-09-21)

Source: https://docs.typesafe.ai/introduction + https://docs.typesafe.ai/llms.txt + API reference + cookbooks (`rerank_typesafe`, `classifying_rag_passages`, `citation_check`).

Scope: optional plugin only — never core, never default-on.

Constraint: TypeSafe ships only as opt-in `packages/plugins/plugin-*-typesafe/` with the `paid` capability + kernel grant gate (INV-003). Core BM25+hybrid retrieval, the heuristic `classifyNoise` filter, and existence-only citation validation stay byte-identical when the plugin is absent or unconfigured (RET-02/RET-03 optional-dep pattern).

## What TypeSafe is (verified 2026-09-21)

- Endpoint: `POST https://api.typesafe.ai/v1/systemone` with `{ state, model: "jev-latest", questions }`.
- Questions: `Choice` (option + `probabilities` + `confidence`), `Score` (weighted `score` + `probabilities` + `confidence`), `Noul` (`noul` 0–1). Mixed per call, evaluated in parallel and in isolation.
- JS SDK: `@typesafe-ai/sdk`, Node 20+, `TYPESAFE_API_KEY`, `client.systemOne()` — compatible with the TS/Node-only rule (INV-001). Do not use the Python SDK (AGENTS.md ground rule 1).
- Billing in tokens: `usage.input_tokens/output_tokens` per call; errors 401/422/429/529 with backoff (SDK retry default).

## Impact verdict: conditional yes, optional plugin only

Fit seams in current code:

1. Rerank for answer packing — `packages/server/src/answer.ts:250` (`searchPassages` vs `hybridSearch`, `maxPassages: 6`). Cookbook pattern: 1 Noul per query×candidate, sort by `noul`. Reference result on CLERC shortlists: top-1 5%→18%, top-10 38%→62%. Applies after existing BM25+fastembed RRF (RET-02, baseline v2 in `evals/baselines/retrieval-baseline.json`).
2. Passage gating — `packages/plugins/plugin-harness-research/src/index.ts:135` `classifyNoise()` is a pure-text heuristic (nav-list/reference/stub/fragment). Cookbook pattern: 4 Nouls per passage (`is_relevant`, `contains_answer_evidence`, `contradicts_query_premise`, `contains_prompt_injection`) + `route()` thresholds in code. Catches paraphrase/hostile shapes heuristics miss.
3. Citation support (not recommended now) — `packages/server/src/answer.ts:421` validates existence only, degrades to evidence-only, no repair loop. Cookbook pattern is `Choice(supports|contradicts|says_nothing)` + confidence gate. Contradicts ADR 0003/R-06; needs an ADR, not a slice.
4. Intent/confidence routing — `packages/plugins/plugin-model-router/src/index.ts:78` single default provider, one bounded call, paid-refusal + cost-ceiling. A `Choice` + `confidence` gate could drive evidence-only degradation. Low-medium value, defer.

Blockers (must hold):

- `plans/sources.md` model providers: `None activated`. Needs a dated pricing/terms entry (<90d), `paid` capability + kernel grant (INV-003), router `pricing` + `maxCostMicroUsd`, `usage_ledger` reserve/settle. Disabled in CI.
- Search `zero LLM` (`plugin-harness-research/src/index.ts:222`) + answer `one bounded call` stand. TypeSafe calls count as external paid calls; offline evals stay 0-network/0-model.
- Absent/unconfigured plugin = byte-identical behavior (parity test required).
- Third-party data send (question+passages) needs owner retention/billing clarity — stop condition until recorded in `sources.md`.

## Tasks

| ID    | Task                                                                                                                                                         | Status   | Owner       | Evidence |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- | -------- |
| TS-00 | Spike in gitignored `.spikes/typesafe/` (spike-runner skill): replay RET-01 held-out set + QUAL subset through rerank + 4-question gating, live key required | proposed | owner-gated | below    |
| TS-01 | If spike wins: `sources.md` dated TypeSafe entry (pricing/1M, quota, retention, key scope)                                                                   | proposed | owner       | below    |
| TS-02 | New `packages/plugins/plugin-rerank-typesafe/` (manifest `paid`, no raw fs/net, budget-aware, default-off `createRuntime` wiring)                            | proposed | owner-gated | below    |
| TS-03 | New `packages/plugins/plugin-evidence-gate-typesafe/` (4-Noul gate + code `route()`) or fold into TS-02                                                      | proposed | owner-gated | below    |
| TS-04 | Docs wiring + QUAL protocol note (limits stated, no offline quality claim)                                                                                   | proposed | owner-gated | below    |

Explicit non-goals: core integration, default-on rerank/gate, Python SDK, citation-entailment change, stealth/CAPTCHA-adjacent use, `.github/workflows` / `scripts/policy.ts` / `plans/invariants.json` edits to make anything pass.

## Plan-creation evidence (2026-09-21, agent)

Files: `plans/012-typesafe-optional-plugin.md` (new, this file). Left untouched: pre-existing dirty `docs/deployment.md`, `plans/005-007-brw-cmp-later.md`, `plans/sources.md` (other owner session work — not staged or committed here).

Commands: `npm run policy` → PASS (6 checks, 0 findings); `npm run check:fast` → first run FAIL prettier on this file only, fixed with `npx prettier --write plans/012-typesafe-optional-plugin.md`, re-run PASS 5/5. Commit stages only this file; push follows.

Risks/open questions: cost/latency per query×candidate unknown until TS-00; thresholds are corpus-specific constants under review, not prompt tweaks; pure HTTPS+JS (no native dep) but adds external availability dependency + 429/529 retry path; data ownership/retention ambiguous until TS-01.

Next suggested task: TS-00 spike only after owner provides key + billing clarity + retention note. Otherwise leave core as-is.
