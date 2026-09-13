---
name: evaluate-retrieval
description: Run and interpret do-sift's fixed evaluation datasets for retrieval, citations, budgets, and cache safety; compare against baselines without overwriting them. Use when measuring retrieval quality, running eval:offline, or judging whether a ranking/index change is an improvement.
---

# evaluate-retrieval

## Procedure

1. Run `npm run eval:offline`. The runner must execute the full registered
   dataset — an empty or partial dataset is a failure (INV-006), never a pass.
2. Compare against `evals/baselines/`. Baselines are versioned artifacts:
   never overwrite silently. A baseline update is its own reviewed change
   with the old version preserved and the reason recorded.
3. Interpret at minimum: passage recall@k, ranking quality, citation-ID
   integrity, cache false-hit count (must be 0 for the exact-cache suite),
   and token ceilings. Mocks prove contract behavior, not factual answer
   quality — say so in the report.
4. Live/manual evaluation (QUAL gate) is the only source of factual-quality
   claims. Do not extrapolate offline scores into quality claims.
5. Record results in the task evidence: dataset version, baseline version,
   per-metric deltas, and whether the change is promoted or rejected.

## Rules

- A change is promoted only if it beats the baseline on the held-out set
  without regressing critical metrics; otherwise revert.
- Clicks/feedback are interest signals, not correctness labels.
