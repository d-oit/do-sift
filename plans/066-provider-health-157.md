# Plan 066 — Provider-health report for issue #157

Status: in-progress (slice, 2026-11-26). Owner: maintainer. Follows plans
060 (retrieval) and 065 (source-quality). Issue #157 asks for small,
high-value, read-only reports over existing schemas with provenance,
deterministic aggregation, explicit missing-data semantics, and no
unsupported quality claims.

This slice implements exactly one report — provider health over stored
provider-call observations — as a pure function in
`packages/analytics/src/provider-health.ts`, re-exported from the package
index. No Parquet I/O (#155 deferred), no live probes, no request-path use.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                                                                                                  | Preconditions                              | Sensor  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| PH-01 | `buildProviderHealthReport(calls, provenance, verifiedCosts?)` with per-provider success/error/degraded counts, latency p50/p95 gating, timeout/rate-limit + retry/Retry-After counts | Plan row exists (this file); #157 criteria | `tests` |
| PH-02 | Tests (red first): ordering/shares, provenance echo, empty input, p50/p95 gating + unknown latency, verified-cost separation, malformed rejection, determinism                        | PH-01 red tests written first              | `tests` |
| PH-03 | Gates: `npm run check:fast`, `npm run check`, signals feedback, `npm run eval:offline`; evidence here                                                                                 | PH-01..02 green                            | `evals` |

Out of scope: Markdown/HTML summary (no consumer), live provider checks
(stay opt-in/gated elsewhere), quota enforcement or price inference.

## Decision notes

- Inputs mirror stored call outcomes, not live probes: each row carries
  `provider`, `outcome` (`success`/`error`/`degraded`), optional
  `latencyMs` (unknown when absent), optional `failureKind` (`timeout` /
  `rate-limited` / `http` / `aborted` / `unknown`), optional `retried`, and
  optional `retryAfterMs` (observed Retry-After in ms, unknown when absent).
  No error-message strings are accepted, so the report cannot leak raw
  provider output, prompts, or private evidence.
- Latency p50/p95 use the same nearest-rank method and `MIN_SAMPLE_N = 5`
  gate as the retrieval report: smaller samples carry `null` with
  `percentileNote: "insufficient-sample"`. `meanLatencyMs` is `null` when no
  call in the group carries a measured latency. Sample counts are stated.
- Timeout/rate-limit counts derive only from the stored `failureKind`;
  retry counts from `retried === true`; Retry-After observations from
  present `retryAfterMs` values. Missing data is counted as unknown, never
  imputed.
- Quota/cost metadata is never inferred from calls: the optional third
  argument `verifiedCosts` is echoed verbatim when the caller supplies
  dated, sourced records, and defaults to `[]`. Measured observations and
  verified metadata stay in separate fields.
- Malformed rows (empty provider, bad outcome, negative/non-integer
  latency, bad failureKind, negative retryAfterMs, malformed verified-cost
  records) are rejected by throwing, mirroring `aggregateEvalResults`.
- Method: vertical-event-slice. No spike: pure deterministic bucketing.

## Evidence

- Red: `provider-health.test.ts` written before `src/provider-health.ts`
  existed (import failure by construction, same pattern as plans 060/065).
- Green: `npx vitest run packages/analytics` — PASS 26/26 (10 aggregate +
  4 retrieval + 6 source-quality + 6 provider-health: ordering/counts,
  p50/p95 gating + null-mean, verified-cost separation, empty input,
  malformed rejection, determinism).
- `npm run check:fast` — PASS 9/9 (after prettier write on the two new
  files + this plan).
- `npm run check` — PASS 12/12 (tests + evals + build).
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls; baselines untouched).
- `npm run signals -- verify --set feedback` — green.
- review-security: no new trust boundary (pure offline aggregation over
  caller rows; no error-message strings accepted so no raw provider
  output/prompts/evidence can leak; provenance + verifiedCosts echoed as
  JSON data, no HTML rendering, no network/files/privilege). Residual:
  provenance and verifiedCosts are caller-attested, not verified —
  consumers must not treat echoed versions as verified facts; counts are
  descriptive, never a reliability score.
