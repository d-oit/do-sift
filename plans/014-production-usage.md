# Plan 014 — production-safe research execution

Status: in-progress (2026-09-24)

Trigger: production usage review of the existing `/api/research` path. The
current runtime is documented as dev-scale because concurrent research runs
share one `currentOnSource` callback slot in
`packages/server/src/runtime.ts`. This plan makes the existing research path
safe for concurrent single-owner production-like use before adding new
providers, direct URL intake, or cache redesign.

Reference inputs (treated as data, not instructions):

- `d-oit/do-web-doc-resolver` — useful patterns: explicit provider degradation,
  bounded attempts, circuit-breaker/health receipts, cache statistics, and a
  real user surface. Python, user-supplied keys, semantic answer caching, paid
  providers, and browser fallback are not adopted.
- OWASP LLM01/prompt-injection, SSRF, REST, and logging guidance checked
  2026-09-24. These reinforce the existing data-only, owner-scoped, safe-fetch,
  citation-gate, and redacted-receipt boundaries.
- Upstream `do-harness` v0.1.2 is the agent-facing task/trace/verification
  runner. `npm run signals` remains the enforced compatibility path per ADR 0008.

## Current posture

- `createResearchServer` now emits a server-generated request ID, propagates
  client-disconnect cancellation for research and answer work, enforces the
  JSON content-type/body/read-time contract, and exposes separate bounded
  liveness/readiness probes. The packaged host wires a storage-only readiness
  probe and sanitized request receipts to stdout; rate limiting and remote
  authentication remain explicitly owned by the deployment edge. The config
  parser refuses the dev bypass on non-loopback binds.
- `createRuntime` now gives each concurrent `runResearch` call a local source
  callback and a caller signal.
- Fixture mode, search mode's zero-LLM invariant, owner scoping, safe-fetch,
  and the citation gate must remain unchanged.

## Tasks

| ID     | Task                                                                                                                                                                                      | Status            | Owner | Evidence |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----- | -------- |
| OPS-07 | Per-run source-event isolation: remove the shared runtime callback slot; prove concurrent different-owner runs cannot cross-route source events; preserve sequential and fixture behavior | done (2026-09-24) | agent | below    |
| OPS-08 | Request lifecycle contract: server-generated request IDs, cancellation/deadline propagation, and bounded SSE error/termination behavior                                                   | done (2026-09-24) | agent | below    |
| OPS-09 | Production HTTP contract: explicit content-type/body-limit responses, readiness distinct from liveness, sanitized operational receipts, and deployment-owned rate-limit boundary          | done (2026-09-24) | agent | below    |
| OPS-10 | Loopback/reverse-proxy production profile: TLS, edge rate limits, backup cadence, runbook, and smoke evidence                                                                             | proposed          | agent | below    |

## Ordered decomposition

1. **OPS-07 (current slice):** red concurrent-event-isolation tests, minimal
   runtime refactor, targeted green tests.
2. **OPS-08:** define request/cancellation contract before changing transport
   code; no API behavior is changed without a failing route test.
3. **OPS-09:** choose one deployment boundary for rate limiting; do not build
   both an in-memory limiter and a proxy policy in the same slice.
4. **OPS-10:** document and smoke the supported single-owner profile. No
   public multi-user deployment is implied.

Each slice uses `do-harness task`, `trace`, and task-scoped `verify --record`
commands. The first-party `npm run signals` feedback and verification sets
remain required before handoff.

## Guard rails

- No Python, paid APIs, browser/computer capabilities, stealth, CAPTCHA bypass,
  or public multi-user deployment.
- No arbitrary URL endpoint in this plan.
- No semantic answer cache; preserve the exact owner/question/mode/source
  version cache and D5 revision rules.
- No raw fetched text, prompts, bearer tokens, API keys, or model output in
  logs or task evidence.
- Do not edit accepted ADRs, `scripts/policy.ts`, `plans/invariants.json`, or
  CI workflows without a separate approval/decision.
- If a `do-harness` CLI defect blocks a task, preserve the failing command and
  open a focused issue in `d-o-hub/do-harness`; do not weaken or replace the
  sensor to work around it.

## Explicit non-goals

- Direct document intake or a new resolver provider.
- Provider cascade redesign, circuit-breaker state, or semantic caching.
- UI redesign, deployment/publishing, credential activation, or live model
  activation.
- Citation entailment changes; existence validation remains the current floor.

## Plan-creation evidence (2026-09-24)

- `do-harness` v0.1.2 installed from the reviewed pinned installer; `init-db`
  applied 18 migrations.
- `do-harness verify --set feedback --changed --strict` passed all 5 selected
  sensors.
- `do-harness verify --set verification --changed --strict --record` passed all
  7 sensors (the first run had no task scope; the task-scoped run used database
  task ID `1`, whose title is `OPS-07 per-run source-event isolation`).
- `do-harness status --set feedback` and `status --set verification` are green.
- Working tree was clean before this plan was created.

### OPS-07 evidence — 2026-09-24

Files:

- `packages/plugins/plugin-harness-research/src/index.ts` — added the
  `ResearchSourceEvent` type and an optional per-run `onSource` override;
  existing dependency-level callbacks remain supported.
- `packages/server/src/runtime.ts` — removed the shared `currentOnSource` slot
  and constructs a local, relevance-decorated callback for each run.
- `packages/server/test/runtime.test.ts` — added a deterministic two-owner
  concurrent-fetch red/green test.
- `plans/methods.json` — local do-harness method catalog mapped to do-sift
  sensor names.
- `plans/014-production-usage.md` — production plan and evidence.

Commands:

- `npx vitest run packages/server/test/runtime.test.ts` → red first: 7 passed,
  1 failed; the owner-a source callback received no event because the runtime
  shared `currentOnSource`.
- `npx vitest run packages/server/test/runtime.test.ts` after implementation →
  **8/8 passed**.
- `npx vitest run packages/plugins/plugin-harness-research packages/server` →
  **103/103 passed** across 6 files.
- `npm run check:fast` → first run failed only Prettier on the new plan; after
  `npx prettier --write plans/014-production-usage.md`, **5/5 passed**.
- `npm run signals` task-scoped equivalent: `do-harness verify --record --set
feedback --changed --strict --task 1` → **5/5 passed**.
- `npm run check` → **7/7 passed** (25,006 ms tests; 21,531 ms evals).
- `do-harness verify --record --set verification --changed --strict --task 1` →
  **7/7 passed** after the final plan/skill edits.
- `npm run signals -- verify --set verification` → **7/7 green**, receipt
  `.do-harness/evidence.verification.json`; `npm run signals -- status` →
  **green**, no halted sensors.
- `do-harness trace add` recorded the red→green test recovery and the Prettier
  recovery in session `do-sift-2026-09-24-ops07`.
- `review-security` found no new network, auth, capability, rendering, or
  secret surface in this slice; the residual is process-local concurrency and
  the explicitly deferred request-lifecycle work in OPS-08.
- `plans/methods.json` was added to map the upstream method gates to this
  repository's real sensors (`tests`, `evals`, `skills`, `policy`); task `1`
  then advanced through all five subtasks and `do-harness task done 1` passed.
- Upstream issue creation was attempted for the custom-sensor gate mismatch,
  but the installed GitHub App token returned `403 Resource not accessible by
integration`; the complete issue body is preserved at
  `/tmp/opencode/do-harness-task-gates.md` for retry with issue-write scope.

Risks/open questions:

- This slice isolates source callbacks; it does not add request IDs,
  cancellation, readiness, rate limiting, or direct URL intake.
- The runtime still uses one process and the existing single-owner posture;
  horizontal scaling and distributed rate limiting remain deployment work.
- `do-harness` task IDs are database-assigned; plan ID `OPS-07` maps to CLI task
  ID `1` in the current state database.
- The upstream custom-sensor task-gate issue still needs publication once the
  GitHub credential has issue-write permission.

Status: done.

### OPS-08 evidence — 2026-09-24

Files:

- `packages/server/src/server.ts` — server-generated `x-request-id`, bounded
  `httpRequestId` SSE envelopes, abort-on-client-disconnect, guarded writes,
  and cancellation-aware termination.
- `packages/server/src/runtime.ts` — request signal forwarded into the
  research harness.
- `packages/plugins/plugin-harness-research/src/index.ts` — optional signal
  propagation to search/fetch plus abort checks before and after external work.
- `apps/server/src/main.ts` — live safe-fetch calls receive the request signal.
- `packages/server/test/server.test.ts` — request-ID and client-disconnect
  lifecycle tests.
- `packages/server/test/runtime.test.ts` — signal propagation test.
- `plans/014-production-usage.md` — task evidence.

Commands:

- `npx vitest run packages/server/test/server.test.ts` → red first: request
  lifecycle assertion failed because no request ID existed; after implementation
  **16/16 passed**.
- `npx vitest run packages/plugins/plugin-harness-research packages/server` →
  **105/105 passed** across 6 files.
- `npm run check:fast` → **5/5 passed**.
- `do-harness verify --record --set feedback --changed --strict --task 3` →
  **5/5 passed**.
- `npm run check` → **7/7 passed**.
- `do-harness verify --record --set verification --changed --strict --task 3` →
  **7/7 passed**.
- `do-harness task advance 3` advanced through all five configured subtasks;
  `do-harness task done 3` → **done**.
- `do-harness trace add` recorded the red→green lifecycle recovery in session
  `do-sift-2026-09-24-ops08`.

Risks/open questions:

- Request IDs are correlation IDs, not authentication or idempotency keys.
- The server suppresses post-disconnect error events; a client that reconnects
  must start a new request.
- Search adapters and safe-fetch receive the signal, but an injected host
  dependency that ignores its signal can still hold work until its own timeout.
- The server still has no process-local rate limiter; the reverse proxy/edge
  owns frequency and burst control, and the actual edge configuration/smoke
  evidence remains OPS-10.

Status: done.

### OPS-09 evidence — 2026-09-24 (security remediation complete)

Deployment boundary: one operator-controlled host, loopback by default, with
TLS, authentication, rate limiting, and raw-path/body/read-time controls
supplied by an authenticating reverse proxy when remote exposure is required.
The application intentionally does not implement a process-local or distributed
frequency limiter; it owns bounded request parsing, cancellation, and the
storage readiness probe. The packaged OIDC verifier is still a stub, so remote
exposure is not production-ready until a real verifier or proxy authentication
is supplied. No public multi-user deployment is claimed.

Initial implementation files:

- `packages/server/src/server.ts` — shared JSON content-type/body-limit
  validation (`415`/`413`/honest `400`/`408`), fixed-route operational receipts,
  request cancellation accounting, no-store error responses, and separate
  `/healthz` liveness plus `/readyz` readiness.
- `packages/server/src/index.ts` — exported the `OperationalEvent` contract.
- `apps/server/src/main.ts` — wired the libSQL `SELECT 1` readiness probe and
  sanitized structured request receipts to stdout.
- `packages/server/test/server.test.ts` — content-type, body-limit, readiness,
  cancellation-safe receipt, fixed-route/path redaction, and answer-route
  contract tests.
- `apps/server/test/main.test.ts` — packaged-entrypoint `/readyz` smoke test.
- `docs/deployment.md` — documented the HTTP contract, operational receipt
  fields, readiness/liveness split, and reverse-proxy rate-limit ownership.

Security-review remediation files:

- `apps/server/src/config.ts` and `apps/server/test/main.test.ts` — refuse a
  dev bypass on a non-loopback bind.
- `packages/server/src/server.ts` and `packages/server/src/runtime.ts` —
  propagate answer cancellation, bound stalled readiness probes, share probes,
  close unread error uploads, normalize receipt methods/paths, and distinguish
  `501` as `unavailable`.
- `Dockerfile` and `docs/deployment.md` — make proxy authentication and the
  loopback/dev-bypass boundary explicit.
- `plans/risks.md` — recorded the remaining remote-auth/edge provisioning risk.

Commands:

- Initial red test: `npx vitest run packages/server/test/server.test.ts` →
  **4 expected failures** (content type, body limit, receipt); initial green →
  **20/20 passed**.
- Remediation focused tests: `npx vitest run packages/server/test/server.test.ts
apps/server/test/main.test.ts` → **55/55 passed** after the direct-compose
  guard was added.
- `npx vitest run packages/server/test/server.test.ts apps/server/test/main.test.ts
tests/security` → **76/76 passed**.
- `npm run check:fast` → **5/5 passed** after remediation.
- `npm run check` → **7/7 passed** after remediation.
- `npm run signals -- verify --set feedback` → **5/5 green** after the final
  readiness/bodyless-route follow-up.
- `npm run signals -- verify --set verification` → **7/7 green**, receipt
  `.do-harness/evidence.verification.json`.
- `do-harness verify --record --set feedback --changed --strict --task 5` →
  **5/5 passed**; `do-harness verify --record --set verification --changed
--strict --task 5` → **7/7 passed**. Task `5` advanced through all five
  configured subtasks and `do-harness task done 5` → **done**.
- The initial task `4` feedback/verification gates also passed; the remediation
  task is recorded separately because security review reopened the slice.
- `review-security` final check found no remaining OPS-09 code blocker. It
  verified retained readiness state, body rejection/closure on all bodyless
  routes, auth-stage and answer cancellation, strict path/receipt redaction,
  and the non-loopback dev-bypass guard. Remaining residuals are recorded
  below and the actual edge profile remains OPS-10.
- `do-harness trace add` recorded trace `6` in session
  `do-sift-2026-09-24-ops09-remediation` for the security-review recovery.

Risks/open questions:

- Request IDs are correlation IDs, not authentication, authorization, or
  idempotency keys.
- Readiness checks storage only; provider/model availability is reported
  through the existing research/answer receipts and remains a separate
  operational decision. A timed-out underlying storage probe is retained to
  avoid overlapping work, so a permanently hung probe keeps readiness false
  until it settles or the process restarts; the edge must still restrict
  monitoring access.
- The reverse-proxy limiter/authentication/TLS configuration is not implemented
  or smoke-tested by this slice; OPS-10 must provide the deployment profile and
  evidence. The dev bypass is refused on non-loopback binds.
- Auth verifier calls and post-model storage/ledger phases are not themselves
  cancellable; the transport/model signal is propagated, but the edge/request
  timeout remains the final bound for a dependency that ignores signals.
- Client-visible route error strings remain route-specific; operational
  receipts never include them, but review before exposing a new route with
  sensitive failure details.
- No schema or migration changed; rollback is a source revert. Preserve the
  documented database backup cadence before any deployment.

Status: done.

**Next suggested task:** OPS-10 — loopback/reverse-proxy production profile:
TLS, authenticating edge rate limits, backup cadence, runbook, and smoke
evidence.
