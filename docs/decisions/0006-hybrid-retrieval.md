# 0006 — bm25 first; local embeddings only when they beat the baseline

Status: accepted (first recorded 2026-09-13 in `plans/adr/0009-fastembed-hybrid-retrieval.md`)

## Context

FTS5/bm25 is free, local, deterministic, and easy to explain. Vector retrieval
can recall paraphrases bm25 misses, but it adds a model runtime, an embedding
store, and a second ranking path whose quality is not obvious without
measurement. Adopting it because it is modern would be an expensive guess.

## Decision

Start with **bm25 as the baseline**. Add embeddings **only if a measured
hybrid path beats the recorded baseline** on the fixed retrieval dataset:

- Embeddings are computed locally (ONNX via `fastembed`), so no hosted API and
  no per-query cost.
- Fusion is reciprocal-rank fusion over the bm25 list and the cosine list.
- The evaluation records bm25 and hybrid metrics separately in a versioned
  baseline; a regression against either fails `npm run check`.
- Omitting an embedder keeps keyword-only behaviour, byte-identical.

## Consequences

- The evaluation is a regression gate, not a promotion gate: at-or-better
  passes, and a deliberate baseline update is the reviewed way to record an
  improvement.
- Embedding failures never fail a run; they emit `research.embeddings-failed`
  and the passages stay bm25-retrievable.
- The dimension of a model's vectors is learned per owner and tenant, so two
  tenants' models cannot silently couple their widths.
- Cost: local inference is real work at store time, and the ONNX runtime is a
  native dependency that must ship prebuilt binaries for the target platforms.
