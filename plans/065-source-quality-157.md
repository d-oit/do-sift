# Plan 065 — Source-quality report for issue #157

Status: in-progress (slice, 2026-11-26). Owner: maintainer. Follows plan
060 (retrieval report). Issue #157 asks for small, high-value, read-only
reports over existing schemas with provenance, deterministic aggregation,
explicit missing-data semantics, and no unsupported quality claims.

This slice implements exactly one report — source quality over stored
documents plus passage-level extraction/noise distributions — as a pure
function in `packages/analytics/src/source-quality.ts`, re-exported from
the package index. No Parquet I/O (#155 deferred), no domain-reputation
inference, no request-path use.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                                            | Preconditions                              | Sensor  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| SQ-01 | `buildSourceQualityReport(documents, passages, provenance)` with calendar date buckets, unknown-data semantics, duplicate rates | Plan row exists (this file); #157 criteria | `tests` |
| SQ-02 | Tests (red first): ordering/shares, provenance echo, empty input, unknown + invalid dates, duplicates, unclassified noise       | SQ-01 red tests written first              | `tests` |
| SQ-03 | Gates: `npm run check:fast`, `npm run check`, signals feedback, `npm run eval:offline`; evidence here                           | SQ-01..02 green                            | `evals` |

Out of scope: provider-health report (next slice), Markdown/HTML
summary (no consumer), near-duplicate similarity (only exact
contentHash groups — "where measured").

## Decision notes

- Inputs mirror storage rows: documents carry `url`, optional `domain`
  (caller-derived), optional ISO `publishedAt`, and `contentHash`;
  passages carry `extractionStatus` and optional `noiseClass`. No join —
  document-level and passage-level distributions are reported side by
  side, matching the issue's separate bullets.
- Publication age uses calendar `YYYY-MM` buckets of `publishedAt`
  (deterministic, no wall clock). Missing or non-conforming dates fall
  in the `unknown` bucket and are counted, never imputed.
- Domain concentration is counts + shares, sorted desc (ties by name) —
  descriptive only, never a reliability score.
- Duplicates are exact `contentHash` groups with >1 document.
- `noiseClass` NULL (legacy/unclassified) is its own `unclassified`
  bucket: it is a stored state, not a guess.
- Malformed rows (empty url/contentHash, empty status) are rejected by
  throwing, mirroring `aggregateEvalResults`.
- Method: vertical-event-slice. No spike: pure deterministic bucketing.

## Evidence

- Red: `source-quality.test.ts` failed to import before
  `src/source-quality.ts` existed.
- Green after: `npx vitest run packages/analytics` — PASS 20/20 (10
  aggregate + 4 retrieval + 6 source-quality: shares/ordering,
  duplicates + passage distributions, empty input, malformed rejection,
  determinism, domain tie-break).
- One typecheck iteration: separated counted bucket shapes from
  share-carrying report shapes (generic-helper strictness).
- `npm run check:fast` — PASS 9/9; `npm run check` — PASS 12/12.
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; baselines untouched).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (pure offline aggregation over
  caller rows; provenance echoed verbatim as JSON data, no HTML
  rendering, no network/files/privilege). Residual (same as plan 060):
  provenance and input rows are caller-attested, not verified; domain
  shares are descriptive concentration, never reliability.
