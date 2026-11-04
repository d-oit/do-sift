# 038 — Owner-gated external integrations (issue #123)

Status: done (2026-11-03), EXT-01…EXT-06 complete. Two rows stay **owner-gated
by design** and are recorded as such, not as "done": a Marginalia api2 key
(Marginalia's key programme is closed — `plans/sources.md`), and a live
provider spend (AGENTS.md approval boundary: anything billable).

Issue #123 asked for three things plus a quality floor: a Marginalia plugin
with key management, rate-limit handling, and fallback on API errors; a live
model adapter that enforces price opt-in and logs every synthesis call; a
nightly end-to-end test using the live adapters; and the quality gate's mean
score to stay ≥ 0.95.

## What was already true

The Marginalia adapter existed (`plugin-search-marginalia`, SRC-15) on the
keyless legacy path, with a polite single 429 retry, gateway retries, and typed
errors; and merged composition already degrades to a surviving provider. The
openai-compat adapter and the model router existed, but **nothing composed the
router**, so nothing enforced price opt-in at the deployment, and **no record
of a synthesis call existed anywhere** beyond the ledger's aggregate token
counts.

## What this slice adds

| ID     | Task                                                              | Status | Acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXT-01 | Marginalia key management + documented keyless fallback           | done   | `config.apiKeySecret` in `packages/plugins/plugin-search-marginalia/src/index.ts` (secret NAME only, resolved via `context.secrets.resolve`); `plugin.json` declares both hosts + `permissions.secrets: ["MARGINALIA_API_KEY"]`; `DO_SIFT_SEARCH_API_KEY_SECRET` wiring in `apps/server/src/config.ts` + `main.ts`; 11 tests in `packages/plugins/plugin-search-marginalia/test/marginalia-key.test.ts` |
| EXT-02 | Price opt-in enforced at composition, not just inside the router  | done   | `DO_SIFT_MODEL_PAID` + `DO_SIFT_MODEL_PRICE_INPUT_PER_1M` / `_OUTPUT_PER_1M` + `DO_SIFT_MODEL_MAX_COST_MICRO_USD` in `apps/server/src/config.ts`; `createModelRouter` is now the answer-path model in `apps/server/src/main.ts`; `apps/server/test/main.pricing.test.ts` (9 tests)                                                                                                                      |
| EXT-03 | Every synthesis call is logged with provider, model, tokens, cost | done   | `migrations/0013_synthesis_call_log.sql` + `SynthesisCallLogService` in `packages/storage/src/synthesis-log.ts`; `AnswerServiceDeps.onSynthesis` emits `SynthesisAuditEvent` in `packages/server/src/answer.ts` after the ledger settles; `packages/server/test/answer.synthesis-log.test.ts` (10 tests)                                                                                                |
| EXT-04 | Live end-to-end suite (search → evidence → synthesis → citations) | done   | `scripts/eval-e2e.ts` (`npm run eval:e2e`), opt-in and refusing without the terms/price gates; hermetic wiring test in `apps/server/test/e2e.live.test.ts` (2 tests)                                                                                                                                                                                                                                    |
| EXT-05 | Nightly workflow for the live suite                               | done   | `.github/workflows/nightly-live.yml` (scheduled `17 4 * * *` + `workflow_dispatch`, never `pull_request`, owner-approved 2026-11-03); skips visibly when secrets are absent, never a silent pass                                                                                                                                                                                                        |
| EXT-06 | Quality floor recorded for the live path                          | done   | `evals/live-gate-thresholds.json` now carries `minMeanQuality: 0.95` alongside the unchanged citation 1.0 / entailment 0.9 / resistance 1.0 / abstention 1.0 / completeness 0.85; `LiveThresholds` in `scripts/eval-live.ts` and `MeanQualityThresholds` in `scripts/eval-e2e.ts` consume it                                                                                                            |

## Owner-gated rows (not started, by design)

| Row    | Why it is owner-gated                  | What the owner must do                                                                                                                                     |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXT-G1 | Marginalia **keyed** api2 endpoint     | Marginalia's key programme is closed (recorded 2026-09-15 and re-checked in this slice's date). The adapter is ready for a key; there is no key to obtain. |
| EXT-G2 | A live provider spend (any paid model) | Choose a provider, record dated pricing in `plans/sources.md`, set `DO_SIFT_MODEL_PAID=1` and the price env vars, then run the nightlies.                  |

## Design notes

- **The gate has to be at composition.** The model router's refusal is
  selection-time, but if a deployment never composes the router the refusal
  never runs. `apps/server` now builds the answer-path model through the
  router, so `paid` + price metadata are required to reach a billable
  provider.
- **A synthesis log is a new table, not a wider ledger row.** The ledger is an
  accounting primitive with a reservation/settlement lifecycle; a call log is
  an audit trail with a provider, a model, verified pricing, and a cost. Mixing
  them would make either one lie. The log is append-only, owner- and
  tenant-scoped, and written best-effort _after_ the call so a logging failure
  never loses an answer.
- **The live suite is opt-in and self-refusing.** It needs the same terms pair
  the server needs plus an explicit opt-in; without them it exits non-zero with
  a named reason rather than skipping quietly. The nightly workflow surfaces
  that as a skipped job, not a green one.
- **Fixture-first hermetic test.** The wiring (router → adapter → answer →
  citation check → evidence store) is proved offline in
  `apps/server/test/e2e.live.test.ts`; the live suite proves the _providers_.
  A live test that only runs nightly cannot be the only evidence that the
  pipeline works.

## Files changed

Search adapter and manifest:

- `packages/plugins/plugin-search-marginalia/src/index.ts` — `config.apiKeySecret`
  (secret NAME), keyed `api2` URL + `API-Key` header, keyless legacy default,
  fail-closed on a non-string / unresolvable / empty secret, activation event
  records `endpoint: "legacy-keyless" | "api2-keyed"`.
- `packages/plugins/plugin-search-marginalia/plugin.json` — two network hosts,
  `permissions.secrets: ["MARGINALIA_API_KEY"]`, `config.apiKeySecret`.
- `packages/plugins/plugin-search-marginalia/test/marginalia-key.test.ts` — new,
  11 tests: keyless default sends no credential; keyed path resolves by name,
  asserts the api2 host, sends the header, never puts the key in the URL;
  non-allowlisted / missing / empty / non-string secret refuses activation;
  429 Retry-After bounded retry, gateway retry, non-JSON 200 typed as `http`.

Configuration and composition:

- `apps/server/src/config.ts` — `searchApiKeySecret`; `paid`, `pricing`,
  `maxCostMicroUsd` on `OpenAICompatModelEnv`; parsing for
  `DO_SIFT_MODEL_PAID`, `DO_SIFT_MODEL_PRICE_INPUT_PER_1M`,
  `DO_SIFT_MODEL_PRICE_OUTPUT_PER_1M`, `DO_SIFT_MODEL_MAX_COST_MICRO_USD`
  (fail-closed: missing/negative/non-numeric/non-integer refuses startup).
- `apps/server/src/compose-contracts.ts` — `searchApiKey`, `retryCapMs` test seams.
- `apps/server/src/main.ts` — Marginalia key resolution + scoped `secrets`
  service; `createModelRouter` as the answer-path model; `onSynthesis` wired to
  `SynthesisCallLogService`; `usdPer1MToMicroUsd` + `toSynthesisFailureKind`
  helpers (exported for tests).
- `packages/plugins/plugin-model-router/src/index.ts` — `name: "model-router"`
  and a `modelId` getter so the router satisfies `ModelProvider` provenance.

Audit trail:

- `migrations/0013_synthesis_call_log.sql` — append-only `synthesis_calls`
  table (tenant, owner, provider, model, tokens, `estimated`, integer micro-USD
  input/output/total costs, the price revision each cost was computed from,
  outcome, failure kind, request/answer ids, timestamp).
- `packages/storage/src/synthesis-log.ts` — `SynthesisCallLogService`,
  `synthesisCostMicroUsd` (rounds **up**), `SYNTHESIS_FAILURE_KINDS`.
- `packages/storage/src/index.ts` — exports.
- `packages/server/src/answer-contracts.ts` + `answer.ts` + `runtime.ts` +
  `index.ts` — `SynthesisAuditEvent` (carries the runtime's `tenantId`),
  `AnswerServiceDeps.onSynthesis` emitted after settlement and swallowed on
  failure so an audit outage never loses an answer, `RuntimeOptions.onSynthesis`
  forwarded.

Evaluation:

- `scripts/eval-e2e.ts` — new `npm run eval:e2e`; `--fixture` hermetic mode
  (writes no artifact), live mode self-refuses without opt-in + owner approval +
  dated terms + sources entry; `MeanQualityThresholds` from the committed file.
- `evals/live-gate-thresholds.json` — `minMeanQuality: 0.95`.
- `scripts/eval-live.ts` — `LiveThresholds` type gained `minMeanQuality`.
- `package.json` — `eval:e2e` script.
- `apps/server/test/main.pricing.test.ts` — new, 9 tests.
- `apps/server/test/e2e.live.test.ts` — new, 2 tests: composed app runs
  search → evidence → synthesis → citation validation → audit row, and a cached
  repeat does not add a second row; two-tenants-one-owner-id log isolation.
- `.github/workflows/nightly-live.yml` — new, owner-approved (EXT-05).

Docs and records:

- `docs/deployment.md` — env table rows for the five new variables, the keyed
  Marginalia path, the router money rules, and the synthesis call log.
- `.env.example` — commented paid/pricing/ceiling and search-key entries.
- `docs/live-eval-runbook.md` — `minMeanQuality`, new §3a on the e2e suite.
- `docs/quality-gate.md` — mean-quality threshold + hermetic preflight.
- `plans/sources.md` — Marginalia addendum (2026-11-03, EXT-01) and model
  providers addendum (2026-11-03, EXT-02), both recording "no call, no key, no
  spend".

## Commands run and results

| Command                                                                 | Result                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npx vitest run packages/plugins/plugin-search-marginalia/test`         | 2 files, **30 tests pass**                                                                       |
| `npx vitest run apps/server/test/main.pricing.test.ts`                  | **9 tests pass**                                                                                 |
| `npx vitest run packages/server/test/answer.synthesis-log.test.ts`      | **10 tests pass**                                                                                |
| `npx vitest run apps/server/test/e2e.live.test.ts`                      | **2 tests pass**                                                                                 |
| `npx vitest run scripts/test/eval-e2e.test.ts`                          | **17 tests pass** (scorer + refusal contract)                                                    |
| `npx tsx scripts/eval-e2e.ts --fixture`                                 | `PASS (fixture)`, exit 0, no artifact written                                                    |
| `npx tsx scripts/eval-e2e.ts` (no flags)                                | exit 1 with the four named refusal reasons                                                       |
| `npx tsx scripts/eval-e2e.ts --opt-in --owner-approval …` (no endpoint) | exit 1: refuses to fall back to the fixture model                                                |
| `npx tsc -p tsconfig.json --noEmit`                                     | clean                                                                                            |
| `npm run check`                                                         | 10/10 PASS (prettier, eslint, typecheck, policy, skills, governance, links, tests, evals, build) |
| `npx vitest run`                                                        | **91 files, 972 tests pass**                                                                     |

## Risks

- **The keyed Marginalia path is unrunnable today.** It is tested, but no key
  exists (EXT-G1). The risk of that is drift, not spend: the code could rot
  before a key appears. Mitigation: the offline tests pin the contract, and
  `docs/deployment.md` states the path is dormant, so nobody deploys expecting
  it to work.
- **A synthesis log row is written even when the model path is free.** Cost 0
  rows are intentional (no silent gaps), but an operator reading raw counts
  must not mistake row count for spend — `totalCostMicroUsd` is the money
  column.
- **`eval:e2e` live mode is narrower than the server's composition.** It
  exercises one search provider (`wikipedia`) and one OpenAI-shaped model, with
  no merged provider, no embedder, and no budget ledger. That is deliberate —
  the suite proves wiring, not recall — but it means a live pass does not vouch
  for a Marginalia-merged deployment. Any other `--provider` value is refused
  rather than silently ignored.
- **Token counts in the log are post-settlement values from the answer**, and
  `estimated` is carried through rather than hidden. A provider that reports
  over/under is visible as `estimated: false` but still inherits the provider's
  number; there is no second reconciliation.
- **The nightly workflow can only fail loudly when it runs.** With no secrets
  configured it skips (by design — a skipped job is honest, a fake green is
  not), which means the live path can stay unexercised indefinitely. That is
  the deliberate trade for not putting live credentials in `pull_request`
  reach; EXT-G2 is the row that closes it.
- **`minMeanQuality` is a blunt scorer.** A case scores 1 only when citations
  resolve, nothing degraded, and the answer was not evidence-only. That is
  strict on purpose (the gate exists to test synthesis, not abstention), but it
  means a model that honestly abstains on one hostile case cannot score 1.0 on
  the e2e aggregate — the corpus-level moral-equivalence cases are what
  `eval:live` scores separately.

## Owner-gated follow-ups

- **EXT-G1** — obtain a Marginalia API key (if the programme reopens), add a
  dated `plans/sources.md` row from a live probe, then set
  `DO_SIFT_SEARCH_API_KEY_SECRET`. The adapter needs no code change.
- **EXT-G2** — choose a provider, record dated pricing, set
  `DO_SIFT_MODEL_PAID=1` + both price vars + a ceiling, then let the nightly
  run. This spends money: AGENTS.md makes it an owner approval boundary, so no
  agent may do it.
