# Plan 019 — multi-tenant / multi-user authentication (#120)

Status: implemented (2026-11-01) — MTA-01 … MTA-05 closed; MTA-06 records the
remaining integration steps honestly.

Trigger: GitHub issue #120 ("Add Multi-Tenant / Multi-User Authentication
Support"). Acceptance criteria from the issue:

- [x] A new `AuthProvider` interface exists and is documented.
- [x] At least one OIDC-based auth plugin is available and tested.
- [x] All storage queries are automatically scoped by tenant.
- [x] The quality gate includes a test for cross-tenant data leakage.
- [x] The owner-allowlist mode remains available as a fallback.

Decision record: [ADR 0010](adr/0010-multi-tenant-auth.md). Operator guide:
[`docs/auth.md`](../docs/auth.md).

## Tasks

| ID     | Task                                                                                                  | Status            | Owner | Evidence |
| ------ | ----------------------------------------------------------------------------------------------------- | ----------------- | ----- | -------- |
| MTA-01 | Contracts: `TenantId`, `Principal`, `AuthProvider`, `AuthProviderError`, `assertSameTenant` + doc     | done (2026-11-01) | agent | below    |
| MTA-02 | `packages/auth`: tenant resolution in `AuthService`, `AllowlistAuthProvider`, `OidcPrincipalProvider` | done (2026-11-01) | agent | below    |
| MTA-03 | Reference `auth`-kind plugin `@do-sift/plugin-auth-oidc` (JWKS verifier, claim → principal, tests)    | done (2026-11-01) | agent | below    |
| MTA-04 | Storage: migration 0011 tenant columns + tenant-scoped repositories/retrieval/embeddings              | done (2026-11-01) | agent | below    |
| MTA-05 | Kernel: `grantScoped` + `activate({ principal })` per-user/per-tenant capability evaluation           | done (2026-11-01) | agent | below    |
| MTA-06 | Follow-ups: request-scoped server wiring, tenant-scoped `BudgetService`/`JobQueue`, SAML provider     | open (owner/next) | agent | below    |

## MTA-01 evidence — contracts

Files: `packages/contracts/src/auth.ts` (new),
`packages/contracts/src/index.ts` (export).

`AuthProvider` is the only identity seam the kernel/storage consume:
`authenticate({ token?, clientAddress? }) → Principal` or a typed
`AuthProviderError`. `TenantId` restricts the alphabet to
`[A-Za-z0-9._:-]{1,128}` so a claim can never inject SQL separators;
`assertSameTenant` is the shared fail-closed check. Documented in
`docs/auth.md` ("The model", "Tenant resolution rules").

## MTA-02 evidence — auth package

Files: `packages/auth/src/auth.ts` (`AuthenticatedOwner.tenantId`,
`AuthConfig.defaultTenant`/`tenantClaim`, `resolveTenant`, failure kind
`tenant-unresolved`), `packages/auth/src/providers.ts` (new),
`packages/auth/src/index.ts`, `packages/auth/package.json` (contracts dep),
`packages/auth/test/{auth,oidc,providers}.test.ts`.

- Owner-allowlist `AuthService` keeps working: default tenant is `default`,
  dev bypass still loopback-only, existing assertions updated with `tenantId`.
- `tenantClaim` configured ⇒ a token without a valid claim throws
  `tenant-unresolved` (never silently defaults).
- `AllowlistAuthProvider` grants the `owner` role and maps `AuthError` kinds to
  `AuthProviderError` kinds.

## MTA-03 evidence — OIDC reference plugin

Files: `packages/plugins/plugin-auth-oidc/{package.json,plugin.json,src/index.ts,test/oidc-plugin.test.ts}`,
`packages/kernel/src/manifest.ts` (`PluginKind` += `auth`),
`package-lock.json` (workspace entry).

The plugin declares `capabilities: ["network"]` and a single manifest host;
activation validates config, asserts `ctx.network.assertHostAllowed(jwksHost)`,
and builds an `OidcPrincipalProvider` over `JwksOidcVerifier`. Tests cover the
manifest posture, kernel activation (no grant needed), claim → principal
mapping, missing/forged token, missing/malformed tenant claim, tenant
allowlist, non-https JWKS, host denial, and deactivation.

## MTA-04 evidence — storage tenant scoping

Files: `migrations/0011_tenants.sql` (new), `packages/storage/src/tenant.ts`
(new), `packages/storage/src/repositories.ts`, `retrieval.ts`, `embeddings.ts`,
`index.ts`, `packages/storage/test/tenant-isolation.test.ts` (new).

Migration adds `tenants`, `tenant_id NOT NULL DEFAULT 'default'` on owners,
documents, passages, passage_embeddings, requests, answers, feedback, episodes,
jobs, usage_ledger, and tenant-first indexes; expand-only, deterministic seed
of the `default` tenant, rollback = restore a pre-migration snapshot.

`Repositories` is bound to one tenant (`default` when unspecified) and filters/
stamps every query; `forTenant(id)` derives a sibling scope. Cross-tenant
writes that link to a foreign parent fail with `not owned by`, foreign updates
are no-ops. `searchPassages`/`searchByEmbedding`/`hybridSearch`/
`storePassageEmbeddings`/`backfillPassageEmbeddings` take a trailing
`tenantId`; the FTS mirror has no tenant column, so the retrieval join
re-checks `passages.tenant_id` and `documents.tenant_id`.

## MTA-05 evidence — capability grants per user/tenant

Files: `packages/kernel/src/kernel.ts`, `packages/kernel/test/kernel.test.ts`.

`grantScoped({tenantId, ownerId?}, plugin, ...caps)`, `effectiveGrants(plugin,
principal?)`, and `activate(name, { principal })`. Instance-wide `grant(...)`
remains the legacy door (still applies to all callers); scoped grants are only
counted for the matching tenant/owner; CI still refuses grant-requiring
plugins; empty tenant/owner scope values throw.

Quality gate: `tests/security/cross-tenant.test.ts` (new) exercises the full
composition — provider → tenant-scoped repositories → answer service → kernel
grants — with the **same owner id** in two tenants, proving reads, FTS
retrieval, answer cache, citations, and capabilities cannot cross.

## MTA-06 follow-ups (open)

1. **Server request path is still single-tenant.** `apps/server` authenticates
   through `AuthService` and passes one shared `Repositories` into the
   runtime/services. Moving to `AuthProvider` + `repositories.forTenant(
principal.tenantId)` requires the runtime/answer services to accept a
   per-request repository scope (and per-tenant budget/job queues); the
   library layer, migration, and plugin are ready for it.
2. **`BudgetService` and `JobQueue`** are bound to whichever tenant wrote the
   rows; their columns exist but filters are not threaded yet. Until then a
   multi-tenant host must not share one queue across tenants.
3. **SAML** was named alongside OIDC in the issue; it is not implemented. A
   SAML assertion consumer would be another `AuthProvider`, no interface
   change required.
4. **Owner ids remain globally unique** (`owners.id` PK), so the same subject
   in two tenants shares one owner row. Per-tenant owner registries would need
   a `(tenant_id, id)` key — a migration to schedule with item 1.

## Verification

Commands and results are recorded in the PR handoff after `npm run check` and
`npm run test:coverage` pass on this branch.
