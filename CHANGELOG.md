# Changelog

All notable changes to do-sift are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer
with an explicit 0.x compatibility policy (minor = breaking, patch = safe).

## [0.1.0] — UNRELEASED

### Added

- Multi-tenant isolation closeout (issue #120, plan 035): the remaining
  storage entry points that could cross a tenant boundary — `searchPassages`,
  `searchByEmbedding`, `hybridSearch`, the embedding/noise backfills, and the
  model-dimension probe — now take the caller's owner and optional tenant, so a
  runtime bound to one tenant cannot read or rewrite another's passages through
  a retrieval path. A principal's tenant claim is checked against the membership
  record before a runtime is resolved. The CLI gained `--tenant` on every data
  command, `retention prune` is tenant-aware, and `tests/security/cross-tenant-scope.test.ts`
  pins the boundary. New invariant INV-008 (cross-tenant isolation) and
  `docs/multi-tenant-auth.md` limits rewritten to match what is actually
  enforced.
- Documentation hub and link gate (issue #121, plan 036): `docs/README.md`
  indexes every guide, `docs/architecture/README.md` explains how the pieces
  fit, `docs/contributing-guide.md` walks a plugin from manifest to tests, and
  `docs/decisions/README.md` indexes the ADRs. A new `links` sensor
  (`scripts/markdown-links.ts` + `scripts/docs/links.ts`) checks every relative
  link and heading anchor across the repo and runs in `npm run check`, the
  dev-signal harness, and `do-harness.toml`; new invariant INV-009.
- Python interop via a local MCP server (issue #122, plan 037 + ADR 0010): the
  engine exposes its research/answer/evidence surface over the Model Context
  Protocol on stdio (`packages/server/src/mcp.ts`, `apps/mcp/src/index.ts`), so
  a Python process can call the tool surface without a Python dependency inside
  the engine. The sidecar alternative was evaluated and deferred; no `.py` file
  enters maintained code (INV-001). Risks R-18/R-19 recorded.
- Keyed Marginalia support, price-gated model composition, a synthesis audit
  trail, and a nightly live run (issue #123, plan 038): the Marginalia adapter
  accepts a secret NAME (`DO_SIFT_SEARCH_API_KEY_SECRET`) and switches to the
  keyed `api2` endpoint, keeping the verified keyless legacy path as the
  default and refusing startup on a named-but-missing key; `apps/server` now
  composes the answer-path model **through the model router**, so
  `DO_SIFT_MODEL_PAID` requires verified per-1M pricing plus a dated sources
  entry and `DO_SIFT_MODEL_MAX_COST_MICRO_USD` bounds one call's worst case;
  every synthesis attempt writes an append-only `synthesis_calls` row
  (migration `0013`) with provider, model, tokens, verified price in integer
  micro-USD, outcome, and failure kind; `npm run eval:e2e` exercises the whole
  search → evidence → synthesis → citation path in one process, refusing live
  runs without opt-in, owner approval, and a dated terms record; and
  `.github/workflows/nightly-live.yml` runs it nightly, skipping visibly when
  no credentials are configured. The live gate's thresholds gained
  `minMeanQuality: 0.95`. The Marginalia keyed path and any paid spend remain
  owner-gated (EXT-G1, EXT-G2) — no key, no call, and no money were used.

- Degradation honesty as an enforced contract (issue #127): the answer path now
  degrades instead of failing — a model-provider error answers from stored
  evidence with `evidenceOnly: true`, and citation validation flags unresolved
  claims per claim rather than dropping the answer or repairing citations. Every
  degraded answer carries a `degradationReason` receipt (`no-evidence`,
  `citation-invalid`, `model-failed`). `evals/degradation/` injects eight failure
  scenarios (search returns nothing, search provider timeout, model synthesis
  failure, answer storage full, evidence storage full, citation resolution
  failure, partial citation failure, cross-question evidence) and asserts the
  exact user-facing message plus the internal `answer.degraded` and
  `http.request` receipts, with a negative receipt assertion where nothing
  should degrade. `npm run check` enforces a degradation-honesty score of 1.0
  computed from that suite instead of manual labels. Each run is recorded in
  `evals/degradation/history.json` and surfaced in the evals dashboard with
  per-run diffs, lifetime per-bucket totals, and a recency-weighted coverage
  note that reports a reason bucket whose share of runs shrank or grew. Plan
  records: `plans/020`–`023` and `plans/025`–`031`.

- Ethical guardrails as code (issue #124, ADR 0005): the browser/computer
  boundaries are now a standalone declarative policy
  (`packages/contracts/src/guardrails.json`) evaluated by a typed engine in
  `@do-sift/contracts`. The kernel validates the policy at construction,
  refuses one that weakens the shipped guarantees, and injects a
  capability-scoped `context.guardrails` that both harnesses consult for
  every action; prohibited stealth/CAPTCHA classes, the LinkedIn
  default-deny, grants, and computer consent are policy decisions covered by
  `tests/security/guardrails.test.ts`. Guides for extension live in
  `docs/guardrails.md`.
- Guardrails Rego export and sync gate (issue #124 follow-up; plans 039–041,
  ADR 0011; PRs #138, #140): `policies/guardrails.rego` ships an OPA-readable
  mirror of `guardrails.json` (execution stays in the TypeScript evaluator; no
  OPA binary). `scripts/guardrails-check.ts` parses the Rego data sets and
  compares each with the JSON in both directions, so a missing, misplaced,
  comment-only, or stale value fails the gate. It runs in `npm run check:fast`
  and as the `guardrails` dev-signal sensor in `npm run signals` and
  `do-harness.toml`; a parity test keeps every `scripts/check.ts` step
  registered as a sensor.
- FND milestone: plugin kernel (`packages/kernel`) with manifest validation,
  capability grants, and lifecycle; shared contracts (`packages/contracts`);
  sample plugin; verification harness (`scripts/`); agent foundation
  (`AGENTS.md`, `.agents/skills/`, `plans/`); CI/security/scorecard/release
  workflow skeletons.
- Packaged service entrypoint (`apps/server`, OPS-05): env-configured
  composition of storage, auth, the RET-04 runtime, and the HTTP server;
  fail-closed provider selection (labeled fixtures only — live adapters
  stay behind their recorded gates); `/healthz` liveness route; the Docker
  image CMD now runs the service with a real healthcheck (build-time
  offline eval unchanged).
- First live search adapter (`plugin-search-wikipedia`, SRC-06): free,
  keyless MediaWiki action API behind the recorded terms gate
  (`plans/sources.md`, checked 2026-09-14); entrypoint live mode fetches
  pages through safe-fetch with every hop checked against the site-access
  policy (`DO_SIFT_FETCH_ALLOWLIST`). Content is CC BY-SA — the evidence
  store preserves attribution per passage.
- Plain-text content path (SRC-07): live page content now comes from the
  MediaWiki plain-text extract endpoint (`prop=extracts&explaintext=1`,
  same permitted host and terms) — no HTML-stripping pipeline exists, so
  template metadata cannot leak into stored passages. Fixes QUAL run-001
  finding F1; QUAL run-002 re-measured the same 8 live questions:
  extraction cleanliness 0.31 → 0.56, overall mean 0.775 → 0.85
  (single-annotator authorial labels, limits in docs/quality-gate.md).
  safe-fetch gained an opt-in `headers` option, and every live request
  carries a descriptive User-Agent per the Wikimedia UA policy (2026).
- Respectful 429 handling (SRC-07, 2026-09-14 policy research): the
  search adapter's single bounded retry honors `Retry-After` exactly
  (delay-seconds or HTTP-date), never retries before the instructed
  delay, and refuses to retry at all when the instruction exceeds the
  bounded cap — or when no usable header arrives and the 5 s etiquette
  floor does not fit the cap (never hot, never early).
