# plans/ — decision records, task plans, invariants

This folder is the project's memory. Agents and humans update it together.
The readable outcome of these records lives under [`docs/`](../docs/README.md);
see the [architecture index](../docs/architecture/README.md) and the
[decision records](../docs/decisions/README.md) for the short versions.

## Layout

- `0NN-*.md` — numbered milestone plans with task tables (one row per task ID)
- `methods.json` — do-harness task-method catalog; subtask gates reference
  this repository's configured sensor names
- `invariants.json` — machine-checked invariants; each maps to an enforcing
  test or script (CI fails if an invariant has no enforcing check)
- [`risks.md`](risks.md) — living risk register with owners and status
- [`sources.md`](sources.md) — dated records of commercial limits, quotas, and terms
  (Turso tiers, search/model providers). Every provider activation gate
  requires a fresh entry here.
- [`adr/`](adr/) — architecture decision records (immutable once accepted)
- `templates/task.md` — task record format

## Current queue

- `044-dependency-review-2026-11.md` — review done (2026-11-09); DRV-02 (Node 24 floor) is on PR #143 and DRV-04/DRV-05 on `chore/dep-04-05-pins`: vitest pinned to `5.1.0` to match its exact coverage peer, Playwright bumped to `1.65.0` with chromium 1254 installed, and the BRW-04 e2e made honest — it had been reporting three green tests in 0–1 ms without launching a browser. DRV-01 (minimatch) landed separately as `043-minimatch-ghsa-g3hv.md` (#142); DRV-03 and DRV-06 are blocked upstream.
- `043-minimatch-ghsa-g3hv.md` — done (2026-11-09); fixes Dependabot alert #18 (`minimatch` GHSA-g3hv-75wg-m249) with an `overrides` entry to `^11.0.5`, since no `eslint`/`typescript-eslint` release accepts 11 yet; lint file set unchanged; removal tracked as R-20.
- `042-guardrails-docs-closeout.md` — done (2026-11-09); docs closeout for plans 039–041: CHANGELOG entry for the Rego export and sync gate, the missing plan 039 index row, and `guardrails` in the `check:fast` comment lines.
- `041-guardrails-sync-hardening.md` — done (2026-11-09, PR #140 squash-merged as 33f50b8); the guardrails sync gate parses the Rego data sets and compares them with `guardrails.json` in both directions (pure `scripts/guardrails/sync.ts`, 13 tests). Verification set green in clean clones on Windows (base and changed) and the feedback set green on WSL2.
- `040-guardrails-sensor-registration.md` — done (2026-11-09, PR #140 squash-merged as 33f50b8); the `guardrails` Rego sync gate from plan 039 is registered as a dev-signal sensor in `scripts/dev-harness/sensors.ts` and `do-harness.toml`, with a parity test pinning every `scripts/check.ts` step to a sensor; verified on Windows and WSL2.
- `039-rego-guardrails-export.md` — done (2026-11-08, PR #138, issue #124); `policies/guardrails.rego` ships as an OPA-readable mirror of `guardrails.json` (ADR 0011) with the `scripts/guardrails-check.ts` sync gate in `npm run check:fast`; execution stays in the TypeScript evaluator.
- `038-owner-gated-integrations.md` — done (2026-11-03, issue #123); Marginalia key management (secret NAME → keyed `api2`, keyless default, fail-closed), the answer path composed through the model router so paid/pricing/ceiling are enforced at composition, an append-only `synthesis_calls` audit table (migration 0013), `npm run eval:e2e` (hermetic `--fixture` + self-refusing live mode), the owner-approved nightly live workflow, and `minMeanQuality: 0.95`. Two rows stay owner-gated by design: a Marginalia api2 key (programme closed 2026-09-21) and any live paid spend (AGENTS.md approval boundary).
- `037-python-interop-mcp-spike.md` — done (2026-11-03, issue #122); the engine exposes research/answer/evidence over MCP on stdio (`packages/server/src/mcp.ts`, `apps/mcp/src/index.ts`) so a Python process can drive the tool surface with no Python in the engine; the sidecar path was spiked and deferred (ADR 0010), and the throwaway spike artifacts were deleted under INV-001.
- `036-dev-docs-and-link-gate.md` — done (2026-11-03, issue #121); `docs/README.md` hub, architecture index, contributor guide, and ADR index, plus a `links` sensor checking relative links and heading anchors across the repo (INV-009) wired into `npm run check`, the dev-signal harness, and `do-harness.toml`.
- `035-tenant-scoping-closeout.md` — done (2026-11-03, issue #120); every remaining storage entry point that could cross a tenant boundary (search, embedding/hybrid retrieval, backfills, dimension probe) takes owner + tenant, the CLI gained `--tenant` on all data commands, `retention prune` is tenant-aware, and `tests/security/cross-tenant-scope.test.ts` pins it (INV-008).
- `034-degradation-trend-deltas.md` — done (2026-11-02, DEG-07); the trend table highlights rows whose reason buckets moved and lists the per-bucket delta. Renumbered from 024 on 2026-11-03 so it no longer shares a number with `024-multi-tenant-auth.md`, which the code cites as "plan 024"; the task ID is unchanged.
- `024-multi-tenant-auth.md` — done (2026-11-03, issue #120); pluggable `AuthProvider` contract, OIDC reference plugin with tenant-claim mapping, tenant-scoped storage (migration 0011 + query layer + schema triggers), per-tenant/per-user capability grants, the cross-tenant leakage suite, and the owner-allowlist fallback preserved. MT-07/MT-08 added membership enforcement in the grant path (`tenant_members` → `Kernel.authorizeForPrincipal`) and per-principal runtime resolution, so one `apps/server` process can serve a configured tenant set with `DO_SIFT_TENANTS`; MT-10 adds an owner-readable membership change log and MT-11 its retention and pruning path; MT-12 makes the recorded role policy, so a `viewer` cannot research (`POST /api/research` and `/api/answer` answer `403` before a runtime or budget is touched) while MT-13 gives that role something to read through `GET /api/evidence` and `/api/answers`, scoped to the caller's own corpus. Owner ids remain global and reads stay owner-scoped (documented limits).
- `033-pr-issue-link.md` — done (2026-11-03); the branch now carries a `Closes #127` commit and a changelog entry for the degradation-honesty contract, so merging the PR links the work to its issue without editing GitHub metadata.
- `032-merge-main-guardrails.md` — done (2026-11-03); merged `main` (#130 guardrails, #131 suite) into the #127 branch keeping both sides, dropped four duplicate degradation plans in favour of main's 019–023 numbering, and renumbered the reason-coverage plan to 031.
- `031-degradation-reason-coverage.md` — done (2026-11-02); failing suite runs name the reason bucket that went missing, and the trend counts emitted receipts. Renumbered from 023 when main's canonical 019–023 numbering was kept in the #130/#131 merge.
- `030-evidence-storage-failure.md` — done (2026-11-02); the degradation suite covers a rejected evidence write (research stores nothing, answer says it has no evidence) beside the answer-write failure, so both issue #127 storage modes are exercised.
- `029-coverage-recovery-receipts.md` — done (2026-11-02); the growing-coverage note also requires the bucket's receipt total to rise, so a wider share of a smaller recent window with fewer receipts is not read as a recovery.
- `028-coverage-recovery-note.md` — done (2026-11-02); the coverage note reports buckets whose share of runs grew across the recency-weighted split as well as those that shrank, so a recovered receipt is visible.
- `027-coverage-recency-weights.md` — done (2026-11-02); the shrinking-coverage warning picks its window from a 0.9-per-run recency decay instead of splitting the history in half, so the newest runs decide.
- `026-degradation-coverage-shrink.md` — done (2026-11-02); the panel warns when a reason bucket's share of runs falls between the earlier and newer halves of the history.
- `025-degradation-lifetime-totals.md` — done (2026-11-02); the trend table sums each reason bucket across recorded runs and shows per-bucket run coverage.
- `023-degradation-history.md` — done (2026-11-02); records each degradation-suite run so the dashboard can trend reason counts instead of one snapshot.
- `022-degradation-dashboard.md` — done (2026-11-02); surfaces the suite's score and expected degradation reasons in the evals dashboard.
- `021-degradation-behavior.md` — done (2026-11-02); evidence-only model fallback, per-claim unresolved citations, and `degradationReason` receipts (issue #127 follow-ups).
- `020-degradation-honesty-suite.md` — done (2026-11-02); issue #127 failure-mode suite with a machine-computed degradation-honesty score enforced by `npm run check`.
- `019-guardrails-policy-as-code.md` — done (2026-11-02, issue #124); the ethical guardrails are now a standalone declarative policy document (`packages/contracts/src/guardrails.json`) evaluated by a typed engine the kernel injects and both harnesses consult per action, with an integrity floor that refuses weakening and tests in `npm run check`. OPA parity is documented, not adopted (Node-only, hermetic pipeline).
- `013-ans-evidence-hardening.md` — done (2026-10-13, ANS-10 → ANS-13); live-model steering re-measure stays owner-gated.
- `014-production-usage.md` — done (OPS-07 through OPS-10); public-domain TLS and public-IP 403 smoke remain owner-side evidence.
- `015-workflow-compaction.md` — done; DHC-06 closed as resolved upstream (v0.2.1, see plan 017 DHC-10).
- `017-harness-v021-template-review.md` — done; follow-ups closed: DHC-11 done, TPL-02 done (2026-10-22 hand-maintained `.agents/SKILLS.md`), DHC-12 superseded (WSL absent, Windows install ahead); TPL-01 agent portion done 2026-10-27 (CODEOWNERS covers every documented sensitive path), ruleset review requirement stays owner; living docs now pin do-harness v0.3.5.
- `018-open-work-closeout.md` — done (2026-10-27); audited all plan rows + the issue tracker (0 open issues), adopted `do-harness loc` with v0.3.5, closed TPL-01's in-repo portion (a stale `@doswa` handle had made CODEOWNERS inert), added the `governance` sensor enforcing guide↔CODEOWNERS coverage, reconciled stale records, and split every file at or above do-harness's decomposition threshold (CLS-06: 13 files, largest 1232 → largest 401 lines) so `do-harness loc` is clean. Owner-gated rows re-verified, not started.
- `016-ci-codeql-remediation.md` — closed. The in-repo _advanced_ CodeQL strategy (CI-01, CI-02, CI-03) was superseded: `codeql.yml` and `security.yml` are both deleted (PRs #44, #46) and CodeQL **default setup** is enabled weekly as the repository's only scanning configuration, which cleared the `code_scanning` ruleset gate. `actions/checkout` and `actions/upload-artifact` are now pinned to v7.0.1 (#47, #48); `main` is green and no pull requests are open. The CI-01/02/03 rows and the merge-gate and `Actions: write` sections are historical — read the plan's "Closing outcome" for the current invariants before acting on them.

Older milestone plans remain as historical evidence. Their detailed task
records and stable IDs are retained; use this queue rather than stale
"next suggested task" notes to choose new work.

## Task lifecycle

`proposed` → `ready` → `in-progress` → `done` (or `blocked`).

A task moves to `done` only when its acceptance evidence is recorded in the
plan file: commands, outputs, and remaining risks. "Tests pass" without a
command record is not evidence.

## Rules

1. Plans are append-friendly: prefer new ADRs over editing accepted ones.
2. Every invariant must have an enforcing check; `scripts/policy.ts`
   validates this mapping.
3. Commercial facts (prices, quotas, terms) expire — record the checked date.
4. Task IDs are stable forever; never reuse or renumber them.
