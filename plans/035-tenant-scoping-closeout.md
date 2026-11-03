# 035 — Tenant scoping closeout (issue #120, follow-up to plan 024)

Status: done (2026-11-03), MT-15…MT-19 complete. One owner-gated change
(`INV-008` in `plans/invariants.json`) was explicitly approved before the
edit; see "Owner approval" below.

Issue #120's acceptance criterion 3 is "All storage queries are automatically
scoped by tenant." Plan 024 delivered tenant scoping for everything reached
through the tenant-bound classes (`Repositories`, `BudgetService`, `JobQueue`,
`TenantMembershipDirectory`, retention). An audit on 2026-11-03 found the
remaining owner-only or tenant-defaulted paths:

| #   | Path                                                               | Problem                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `getExistingModelDimension` (`packages/storage/src/embeddings.ts`) | `WHERE model_id = ? LIMIT 1` — reads a vector length sampled from an arbitrary row, possibly another tenant's.                                          |
| b   | `storePassageEmbeddings` / `backfillPassageEmbeddings`             | derive the tenant from the owners row but cannot be told which tenant the caller believes it is serving.                                                |
| c   | `backfillPassageNoiseClasses` (`packages/storage/src/noise.ts`)    | owner-only predicate.                                                                                                                                   |
| d   | `searchPassages` / `searchByEmbedding` / `hybridSearch`            | derive the tenant from the owners row; a wrong-tenant runtime still matches the owner.                                                                  |
| e   | every `apps/cli` data command                                      | owner-only predicates; `retention prune` silently defaults to the `default` tenant, so a non-default tenant's history can never be pruned from the CLI. |

These fail closed today only because `owners.id` is a global primary key — a
limit `docs/multi-tenant-auth.md` records. This plan removes the reliance.

## Task rows

| ID    | Task                                                              | Status | Acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MT-15 | Tenant scope is explicit on every retrieval/embedding/noise entry | done   | `searchPassages`/`searchByEmbedding`/`hybridSearch`/`backfillPassageEmbeddings`/`backfillPassageNoiseClasses`/`getExistingModelDimension` accept a tenant scope that must agree with the owners-row derivation (`packages/storage/src/{retrieval,embeddings,noise}.ts`); callers in `packages/server/src/answer.ts` and `packages/plugins/plugin-harness-research/src/index.ts` pass `repositories.tenantId` |
| MT-16 | CLI data commands take `--tenant` and filter on `tenant_id`       | done   | `apps/cli/src/cli.ts` — `tenantScope()` (default `default`), every data statement carries `tenant_id`; `apps/cli/test/cli.test.ts` updated; `tests/security/cross-tenant-scope.test.ts`                                                                                                                                                                                                                      |
| MT-17 | `retention prune` prunes the tenant it was told about             | done   | `apps/cli/src/cli.ts` passes `tenantId` into `executeOwnerRetention`; cross-tenant test asserts the default tenant's job survives a `globex` prune                                                                                                                                                                                                                                                           |
| MT-18 | Cross-tenant suite covers the newly scoped paths                  | done   | `tests/security/cross-tenant-scope.test.ts` — 10 cases over bm25, vector, hybrid, dimension sampling, embedding write refusal, noise backfill, and five CLI commands                                                                                                                                                                                                                                         |
| MT-19 | Docs record the closed gaps and the remaining global surfaces     | done   | `docs/multi-tenant-auth.md` "Limits" rewritten; `INV-008` registered in `plans/invariants.json` (owner-approved 2026-11-03)                                                                                                                                                                                                                                                                                  |

## Design notes

- **Two-way binding, not one-way trust.** A scope parameter never _replaces_
  the owners-row derivation: the query requires both to agree, so a caller
  that passes the wrong tenant finds nothing instead of reading the owner's
  rows under the wrong tenant.
- **`--tenant` defaults to `default`.** Single-owner CLI usage keeps working;
  the predicate is present either way, so a defaulted command cannot see a
  non-default tenant's rows even if an owner id were ever re-used.
- **`getExistingModelDimension` takes the owner.** A dimension learned from
  another owner's model run would couple two tenants' embedding widths; the
  caller now names whose rows it may sample.

## Owner approval

`plans/invariants.json` is an AGENTS.md approval boundary. The maintainer
approved adding `INV-008` (cross-tenant isolation) and `INV-009` (docs link
integrity) for this branch on 2026-11-03, in the same turn as the approval
for the scheduled live-e2e workflow in plan 036.

## Evidence (2026-11-03)

Files changed:

- `packages/storage/src/retrieval.ts` — `searchPassages` tenant scope
- `packages/storage/src/embeddings.ts` — `getExistingModelDimension` takes
  the owner; `EmbeddingRowInput.tenantId`, `BackfillOptions.tenantId`,
  store/backfill/search/hybrid scope
- `packages/storage/src/noise.ts` — `backfillPassageNoiseClasses` tenant scope
- `packages/storage/src/index.ts` — re-export `DEFAULT_TENANT_ID`
- `packages/server/src/answer.ts` — every retrieval call passes
  `deps.repositories.tenantId`
- `packages/plugins/plugin-harness-research/src/index.ts` — embed and noise
  backfills pass `repositories.tenantId`
- `apps/cli/src/cli.ts` — `tenantScope()`, `--tenant` on every data command,
  `tenant_id` predicates, `retention prune` tenant wiring, export receipt
- `scripts/eval.ts` — retrieval eval passes the `default` scope explicitly
- `tests/security/cross-tenant-scope.test.ts` (new) — 10 cases
- `docs/multi-tenant-auth.md`, `plans/invariants.json` (INV-008),
  `plans/README.md`, `CHANGELOG.md`

Commands run:

- `npx vitest run tests/security/cross-tenant-scope.test.ts` → 10 passed
- `npx vitest run` → 85 files, 892 tests, all pass
- `npm run check:fast` → 6/6 PASS after `prettier --write`
- `npm run check` → see `plans/036` (shared final run for this branch)

Acceptance criteria mapping (issue #120):

1. `AuthProvider` interface documented → unchanged from plan 024
   (`packages/contracts/src/auth.ts`, `docs/multi-tenant-auth.md`).
2. OIDC plugin tested → unchanged.
3. All storage queries tenant-scoped → **closed here** for the retrieval,
   embedding, noise, and CLI surfaces; the remaining tenant-registry,
   migration, backup, and metrics surfaces are global by design and recorded
   in `docs/multi-tenant-auth.md` "Limits".
4. Cross-tenant leakage test in the quality gate → two suites, now under
   `INV-008`.
5. Owner-allowlist fallback → unchanged.

## Risks

- Retrieval's tenant scope is optional (absent = previous behaviour) so that
  single-tenant tooling and the `Repositories.db` escape hatch keep working;
  the servers always pass it. A future change should make it required in
  `Repositories`-owned wrappers rather than on the free functions.
- `tenants.get`/`ensure` remain globally addressable. That is the registry,
  not tenant data; a per-tenant deployment should not expose them to
  principals (neither the HTTP server nor the CLI does).
