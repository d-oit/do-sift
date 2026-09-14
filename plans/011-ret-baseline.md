# Plan 011 — RET: held-out retrieval baseline (the RET gate's missing measurement)

Status: done (2026-09-13)

Goal: close the gap SRC-04 registered and the evaluate-retrieval skill
prescribes but that was never built: `evals/datasets/` had only
contract-level suites (budget/cache/citations) — no retrieval-quality
dataset, no `evals/baselines/`, so bm25 relevance ("the RET gate") was
unmeasured. This plan adds a fixed, versioned held-out retrieval dataset
with authorial relevance labels, wires it into `scripts/eval.ts` (the
`evals` sensor), and records the first FTS5/bm25 baseline as a versioned
artifact.

Honesty constraints (evaluate-retrieval skill): the labels are authorial
intent over a synthetic corpus — they measure lexical-retrieval behavior,
not factual answer quality; live/manual evaluation (QUAL gate) remains the
only source of quality claims.

## Tasks

| ID     | Task                                                                                                             | Status | Owner | Evidence |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------ | ----- | -------- |
| RET-01 | Held-out retrieval dataset + versioned baseline + eval integration; record the first bm25 measurements           | done   | agent | below    |
| RET-02 | Hybrid retrieval: migration 0005, embedding storage + RRF fusion, fastembed embedder, baseline v2                | done   | agent | below    |
| RET-03 | Wire embedding indexing into the research pipeline (embed-on-store, honest degradation)                          | done   | agent | below    |
| RET-04 | Host composition seam: `createRuntime` wires research (embed-on-store) + answer (hybrid) from one options object | done   | agent | below    |

## Decomposition (htn-planner workflow per plan 009)

1. Author `evals/datasets/retrieval.json`: fixed corpus (~36 passages,
   8 topic clusters + decoys sharing terms), ~12 queries with labeled
   relevant ids — lexical-easy cases, two paraphrase cases (expected low
   recall under bm25), one ambiguous-term case, one tokenless case
   (honest-empty).
2. Extend `scripts/eval.ts` with an async `evalRetrieval()`: build an
   in-memory libSQL DB, apply migrations, seed the corpus, run
   `searchPassages` per query, compute recall@k and MRR, compare aggregates
   against the versioned baseline (regression gate: actual ≥ baseline).
   Fail closed when the baseline is missing — the runner prints the
   measured metrics and fails, so a baseline can only be recorded
   deliberately.
3. Record `evals/baselines/retrieval-baseline.json` (baselineVersion 1,
   datasetVersion 1, recordedAtUtc, note: not factual quality).
4. Verify (evals sensor + full check) and record evidence.

## RET-01 evidence (2026-09-13, agent)

**Files:** `evals/datasets/retrieval.json` (new: 36-passage synthetic
corpus in 8 topic clusters with decoys; 14 labeled queries — 10 lexical,
2 paraphrase with low lexical overlap, 1 ambiguous-term, 1 tokenless),
`evals/baselines/retrieval-baseline.json` (new, baselineVersion 1),
`scripts/eval.ts` (async `evalRetrieval`: seeds the corpus into an
in-memory libSQL DB via repositories + migrations, runs `searchPassages`
per query, computes recall@k / MRR / hit-rate, regression gate
actual ≥ baseline, fail-closed with printed metrics when the baseline file
is missing; `run()` made async under the same PASS/FAIL contract).

**First measured bm25 baseline (datasetVersion 1):** meanRecallAtK = 0.75,
meanMRR = 0.8035714285714286, meanHitRate = 0.8571428571428571 (12/14
queries retrieved ≥1 relevant passage in top-k). The misses are the
honest profile: paraphrase queries with little lexical overlap and the
ambiguous single-term query — exactly the cases a future hybrid/vector
ranking (plan 007's gate) must beat before promotion.

**Commands:** `npm run eval:offline` (first run) → FAIL 1/25 with the
fail-closed message printing measured metrics — the baseline was then
recorded deliberately from those numbers, per the evaluate-retrieval
skill's no-silent-baseline rule; re-run → PASS (28 deterministic cases, 0
network, 0 model calls); `npm run check` → PASS all 7 steps (evals sensor
1218ms). No edits to `plans/invariants.json`, `scripts/policy.ts`, or
`.github/workflows`.

**Interpretation limits (skill-mandated):** labels are authorial intent
over a synthetic corpus; these numbers prove lexical-retrieval behavior
and regression-safety of future retrieval changes — they say nothing about
factual answer quality (QUAL gate, live/manual, remains the only source of
quality claims).

**Risks / open questions:** relevance labels are single-author and
English-only; the corpus is small, so per-query ranks are stable but the
aggregate is coarse; determinism relies on the pinned libSQL version in
the lockfile (a dependency bump that shifts bm25 ordering will surface as
a baseline regression to review, which is the desired behavior). Baseline
promotion procedure: update `retrieval-baseline.json` with a new
baselineVersion + reason, old version preserved in git history.

**Next suggested task:** RET-02 (hybrid/vector half) only after a ranking
change is proposed; otherwise OPS tasks in plans/005-007 (other owner) or
the owner-gated live provider adapter.

## RET-02 adoption spike (opened 2026-09-13, spike-runner workflow per plan 009)

The RET gate in plans/005-007 is now measurable — RET-01 recorded the FTS5
baseline this gate names. Before any RET-02 implementation or dependency
ADR, the uncertainty is de-risked in a spike.

**Hypothesis (stated before code):** local ONNX embeddings via the
`fastembed` npm package (pure JS over onnxruntime-node — no Python, per
AGENTS.md ground rule 1; the pre-gitignored `.fastembed_cache/` suggests it
was the anticipated choice) embed the RET-01 corpus and queries well enough
that cosine ranking **beats the bm25 baseline on the same held-out set**
(recall@5 0.75 / MRR 0.80 / hit-rate 0.857), especially on the two
paraphrase queries where lexical matching missed.

**Method:** isolated scratch in gitignored `.spikes/ret02-embeddings/`
(deleted after findings are recorded). Success = exit 0 from a scratch
harness that (a) embeds the RET-01 corpus + queries with the real package
and model, (b) ranks by cosine similarity with the SAME metric definitions
as RET-01, and (c) prints a verdict against the recorded baseline.
Additional probes: model identity/size, download+cache behavior,
determinism (embed twice → identical vectors), and wall time. libSQL
`vector index` support is probed only as far as the pinned client exposes
it; brute-force cosine is acceptable for the measurement. Findings feed an
ADR proposal (any embedding dependency is an owner decision); scratch code
never leaks into packages/.

**Spike findings (2026-09-13, harness exit 0; scratch deleted, model cache
kept in gitignored `.fastembed_cache/`):**

- `fastembed` 2.1.0 — pure JS over onnxruntime-node (no Python ✓), model
  `BAAI/bge-small-en-v1.5` (384 dims), ~67 MB download cached on first use,
  init ~11 s incl. download, ~5.7 s to embed 50 texts on CPU.
- **Vector ranking beats the recorded bm25 baseline on all three metrics:**
  meanRecallAtK 0.893 (vs 0.75), meanMRR 0.845 (vs 0.804), meanHitRate
  0.929 (vs 0.857). Both paraphrase queries bm25 missed now retrieve their
  relevant passages (recall 1.00); remaining misses: "budget reservation"
  second relevant passage outside top-5, "citation failure degradation"
  MRR 0.33, tokenless query 0.00 (as designed).
- Deterministic on the same machine: identical text → identical vector.
- **libSQL vector functions UNSUPPORTED** by the pinned `@libsql/client`
  (`vector_distance_cosine`: "no such function" on `:memory:`) — a native
  vector index is a Turso-side activation question (sources.md caveat
  already records it); brute-force cosine is the dev-scale approach.
- Embedding queries used the bge v1.5 documented query prefix; passages
  embedded raw.

**Outcome:** ADR 0009 drafted (fastembed dependency + hybrid retrieval
shape) and **accepted by the owner** (the owner's "next" immediately
following the proposal, the session's standing steering pattern) — RET-02
implemented below.

## RET-02 evidence (2026-09-13, agent) — hybrid retrieval implemented + promoted

**Files:** `migrations/0005_passage_embeddings.sql` (new:
passage_embeddings — passage_id PK/FK, owner_id, model_id, Float32 vector
BLOB, created_at; owner+model index), `packages/storage/src/embeddings.ts`
(new: `TextEmbedder` interface, vector/blob conversion, cosine,
`storePassageEmbeddings`, owner+model-scoped `searchByEmbedding` with
brute-force cosine over SQL-filtered candidates, `rrfFuse` (k=60),
`hybridSearch`, `backfillPassageEmbeddings` for not-yet-embedded passages),
`packages/storage/src/fastembed-embedder.ts` (new: fastembed-backed
embedder — passages raw, queries with the bge v1.5 search prefix; model
cached in gitignored `.fastembed_cache/`), `packages/storage/src/index.ts`
(exports; appended after the other owner's backup exports),
`packages/storage/package.json` (+`fastembed` ^2.1.0),
`packages/server/src/answer.ts` (optional `embedder` dep — hybrid when
provided, plain bm25 unchanged when not), `scripts/eval.ts` (both paths
measured; baseline v2 gate), `evals/baselines/retrieval-baseline.json`
(v2), tests: `packages/storage/test/embeddings.test.ts` (new, 11 tests,
synthetic vectors only) and `packages/server/test/answer.test.ts` (+2).

**Design:** the embedder is injected — storage stays free of the ONNX
runtime at the interface level, with fastembed as storage's own dependency
for the default implementation. Hybrid = RRF over the bm25 list and the
cosine list; passages without embeddings surface only via bm25; tokenless
questions still retrieve via vectors. The answer service defaults OFF
(no embedder → byte-for-byte the ANS-03 behavior); wiring it on is a host
decision now that promotion is measured. `backfillPassageEmbeddings` is
the production seam for indexing passages after research runs.

**Measured on the held-out set (deterministic):** bm25 unchanged
(0.75 / 0.8036 / 0.8571 — v1 values hold); hybrid 0.8214 / 0.8333 /
0.9286 — beats bm25 on all three metrics. Baseline promoted to v2 with
both blocks; the evals sensor gates each path against its own block
(31 deterministic cases total, 0 network, 0 model calls — local ONNX
inference is not an LLM call).

**Commands:** `npx vitest run packages/storage packages/server` → 85/85;
first eval run after the code change → fail-closed "baseline is v2-shaped"
printing both measured metric sets (the deliberate-recording rule caught
the v1→v2 transition exactly as designed); baseline v2 recorded; re-run →
PASS 31 cases; `npm run check` → PASS all 7 (evals 19856ms — ONNX
inference included). No edits to `plans/invariants.json`,
`scripts/policy.ts`, or `.github/workflows`; the other owner's uncommitted
storage/backup files were left untouched (exports appended after theirs).

**Risks / open questions:** answer-path hybrid defaults OFF until the host
wires an embedder (promotion measured, flip is one line); embedding at
insert time is NOT wired into the research pipeline yet —
`backfillPassageEmbeddings` must be called by the host after runs (next
slice candidate); model downloads ~67 MB on first use per machine;
onnxruntime-node adds a native dependency to the storage package; RRF k=60
is the textbook constant, not tuned; hybrid MRR (0.833) sits between
pure-vector (0.845, spike) and bm25 (0.804) — fusion trades a little
rank-1 precision for recall and hit-rate.

**Next suggested task:** wire `backfillPassageEmbeddings` into the research
pipeline's insert path + flip the answer-path default to hybrid (now
measured); otherwise OPS tasks (other owner) or the owner-gated live
provider adapter.

## RET-03 evidence (2026-09-13, agent) — embed-on-store in the research pipeline

**Files:** `packages/storage/src/repositories.ts` (+public `db` getter —
raw client access for storage-adjacent tooling such as embedding backfill;
owner scoping stays the caller's SQL contract, same as every direct-tooling
use), `packages/plugins/plugin-harness-research/src/index.ts` (optional
`embedder` dep; post-storage backfill in `run`; `embedded` count on the
summary), `packages/plugins/plugin-harness-research/test/research-harness.test.ts`
(+2 tests; makeDeps gained `embedder`/`onEvent` seams).

**Design:** when an embedder is injected, `run()` calls
`backfillPassageEmbeddings(repositories.db, ownerId, embedder)` after the
fetch/store loop and budget settlement — new passages become
hybrid-retrievable immediately; already-embedded passages are skipped by
the backfill query (no re-inference). Local ONNX inference performs no
external calls and touches no ledger rows, so the zero-LLM search-mode
discipline is unchanged (ADR 0009). **Honest degradation:** an embedder
failure NEVER fails the research run — the run has already stored its
evidence with provenance; the failure emits `research.embeddings-failed`
(with the message) and leaves `summary.embedded` undefined; the passages
stay bm25-retrievable. The answer-path default remains OFF (no embedder →
byte-identical ANS-03 behavior); flipping it is a host wiring decision the
RET-02 promotion now supports with measured evidence.

**Commands:** `npx vitest run packages/plugins/plugin-harness-research` →
11/11 pass (new: indexing run embeds all 3 stored passages and the
Alpha passage ranks first through `searchByEmbedding`; embedder-failure
run stores both documents and emits `research.embeddings-failed` with
`embedded` undefined). `npm run check` → PASS all 7 steps (prettier 3821ms,
eslint 2962ms, typecheck 1309ms, policy 455ms, skills 391ms, tests
12161ms, evals 5786ms). One iteration: the first RET-03 test run failed on
a missing `searchByEmbedding` import in the test file — fixed, re-run
green. No edits to `plans/invariants.json`, `scripts/policy.ts`, or
`.github/workflows`.

**Risks / open questions:** embed-on-store runs after budget settlement by
design (inference is local, unbilled) — a very slow embedder delays the
`run()` return; if that ever matters, indexing can move to the job queue
(jobs.ts exists) as a follow-up. `db` getter widens Repositories' surface —
documented as tooling-only; plugin code receiving `repositories` could in
principle query raw SQL, but plugins already hold the client through other
tooling paths and the kernel policy scan governs plugin imports, not host
wiring. Server composition (apps/web or a future host) has not flipped the
answer path to hybrid yet.

**Next suggested task:** flip the server answer path to hybrid by wiring
`createFastEmbedEmbedder()` at host composition (now measured + indexed
end-to-end); otherwise OPS tasks (other owner) or the owner-gated live
provider adapter.

## RET-04 evidence (2026-09-13, agent) — host composition seam

**Files:** `packages/server/src/runtime.ts` (new: `createRuntime(options)`
→ `{ repositories, budgets, runResearch, answer }` — one options object
wires Repositories, optional BudgetService (DailyCaps), the research
harness (embed-on-store via the RET-03 dep), and the answer service
(hybrid via the same embedder); onSource forwarding is per-call (single
slot, dev scale, documented); the factory is async and awaits harness
activation so configuration errors surface at composition, not as
unhandled rejections), `packages/server/src/index.ts` (+exports),
`packages/server/test/runtime.test.ts` (new, 3 tests).

**Design:** providing `embedder` flips BOTH sides (research indexes what
it stores; answers retrieve hybrid) — omitting it keeps byte-identical
pre-RET keyword-only behavior, asserted by the parity test. The runtime
performs no raw I/O beyond the injected deps (server.ts's own boundary
unchanged: it still takes `runResearch` as a callback; the runtime is what
a deployment host passes into it). Tests use a synthetic embedder — the
real fastembed embedder is exercised by the evals sensor against the v2
baseline.

**Commands:** `npx vitest run packages/server` → 26/26 (3 new: hybrid
loop end-to-end — research indexes 2 passages, answer retrieves with
provenance intact; no-embedder parity — `embedded` undefined, zero
vectors stored; repeat-run backfill embeds only the new passages).
One typecheck iteration (exactOptionalPropertyTypes on the optional
maxPassages option) fixed with a conditional-args spread. `npm run check`
→ PASS all 7. No edits to `plans/invariants.json`, `scripts/policy.ts`,
or `.github/workflows`.

**Risks / open questions:** the runtime composes directly against the
harness without the kernel (host-wired composition, matching the server
tests' existing pattern; the kernel round-trip lives in the plugin's own
tests); concurrent research runs share the onSource slot (dev scale —
serialize runs or queue if that ever changes); deployment wiring
(docs/deployment.md, other owner) should reference `createRuntime` when
the OPS tasks pick it up.

**Next suggested task:** the RET milestone is end-to-end complete
(indexed → hybrid → measured). OPS tasks in plans/005-007 (other owner)
or the owner-gated live provider adapter; committing the session's work
remains the owner's call.
