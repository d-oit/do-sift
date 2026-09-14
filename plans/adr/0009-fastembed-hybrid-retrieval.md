# ADR 0009 — Local embeddings via fastembed for hybrid retrieval

Status: accepted 2026-09-13 (owner go-ahead following the spike proposal)

## Context

The RET gate (plans/005-007) allows local ONNX embeddings + a vector index
**only after beating the FTS5/bm25 baseline on the held-out set**. RET-01
(plans/011) recorded that baseline: `evals/baselines/retrieval-baseline.json`
v1 — meanRecallAtK 0.75, meanMRR 0.804, meanHitRate 0.857 over 14 labeled
queries, with the misses concentrated in paraphrase and ambiguous queries.
A spike-runner harness (2026-09-13, scratch since deleted) then embedded the
same dataset with `fastembed` 2.1.0 (pure JS over onnxruntime-node; **no
Python**) using `BAAI/bge-small-en-v1.5` (384 dims) and ranked by cosine:

- vector metrics: meanRecallAtK **0.893**, meanMRR **0.845**, meanHitRate
  **0.929** — beats the bm25 baseline on all three metrics;
- both paraphrase queries bm25 missed now retrieve their relevant passages
  at rank 1–2;
- deterministic on the same machine (identical vectors for identical text);
- model download ~67 MB, cached in the gitignored `.fastembed_cache/`;
  embedding 50 texts took ~5.7 s CPU (one-time init ~11 s incl. download);
- the pinned `@libsql/client` does NOT expose libSQL vector functions
  (`vector_distance_cosine` etc. unsupported on `:memory:`) — so a native
  vector index is a Turso-side activation question (already a sources.md
  caveat), and brute-force cosine is the honest dev-scale approach.

## Decision (proposed)

Adopt `fastembed` (npm, pinned) as the local embedding dependency and build
RET-02 hybrid retrieval as:

1. **Embeddings at rest:** a new migration adds `passage_embeddings`
   (passage_id FK, model_id, vector BLOB); embeddings are computed locally
   at insert time — zero network at query time after the one-time model
   download.
2. **Hybrid ranking:** keep the FTS5/bm25 path and merge cosine ranks with
   it (reciprocal-rank fusion; exact weighting is RET-02's task, measured
   against the held-out set before promotion).
3. **Measurement first:** the evals retrieval stage gains a second metrics
   block (vector and fused); promotion requires beating the recorded
   baseline per the evaluate-retrieval skill, with the baseline updated as
   its own reviewed change.
4. **Index:** brute-force cosine at current scale; `libsql_vector_idx` only
   on engines that support it, probed at the Turso activation gate
   (plans/sources.md).

## Consequences

- New native dependency (`onnxruntime-node` ships Windows/Linux/macOS
  binaries); one-time model download (~67 MB) cached outside version
  control; embedding inference is local ONNX — it is not an LLM API call,
  so the zero-LLM-call token discipline and budget ledger are untouched.
- The bm25 path is not removed: fusion order and fallback behavior are
  measured, and the evaluate-retrieval skill's promotion rules decide.
- If the owner rejects the dependency, RET stays keyword-only and this ADR
  is marked rejected with the spike numbers preserved as the reason.

## Alternatives considered

- `@huggingface/transformers` (larger surface, same runtime); OpenAI-style
  hosted embeddings (violates D9/free-first and the zero-network eval
  discipline); deferring RET entirely (the gate is now measurable — the
  spike shows a real, bounded improvement worth recording).
