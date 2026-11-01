# Authentication & multi-tenancy

Status: implemented (#120, ADR 0010). Single-owner deployments are unchanged;
multi-tenant deployments opt in per component.

## The model

| Concept             | Where                            | Meaning                                                                   |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `TenantId`          | `@do-sift/contracts` (`auth.ts`) | Isolation boundary. `[A-Za-z0-9._:-]`, 1–128 chars, validated fail-closed |
| `Principal`         | `@do-sift/contracts` (`auth.ts`) | `{ tenantId, ownerId, roles, via }` — the authenticated caller            |
| `AuthProvider`      | `@do-sift/contracts` (`auth.ts`) | Pluggable door: `authenticate(request) → Principal` or throws             |
| `AuthProviderError` | `@do-sift/contracts`             | Typed failure kinds; never carries unverified data                        |

The kernel and the storage layer depend on `AuthProvider` only — never on an
implementation. Two implementations ship in-repo:

1. **`@do-sift/auth` `AllowlistAuthProvider`** — wraps the existing
   owner-allowlist `AuthService` (OIDC id-token + timing-safe allowlist
   compare, loopback-only dev bypass). This is the **fallback**: existing
   single-owner deployments keep their config, behaviour, and tests. Tenant
   is `default` unless `tenantClaim` is configured.
2. **`@do-sift/plugin-auth-oidc`** — reference `auth`-kind plugin. Verifies
   OIDC id tokens with the pinned `JwksOidcVerifier` (RS256/ES384 only,
   JWKS-cached, iss/aud/exp/nbf checked) and maps verified claims to a
   `Principal` via `OidcPrincipalProvider` (tenant claim, roles claim,
   optional tenant allowlist). Declares only the non-grant `network`
   capability, and may only contact the host in `permissions.networkHosts`.

`OidcPrincipalProvider` is exported from `@do-sift/auth` too, so an embedder
can use the mapping logic without the plugin kernel.

## Tenant resolution rules (fail closed)

- `tenantClaim` unset → the configured `defaultTenant` (default: `default`).
- `tenantClaim` set → the verified claim **must** be present and a valid
  `TenantId`; a missing or malformed claim throws `tenant-unresolved`. A
  missing claim never silently lands in the default tenant.
- `tenantAllowlist` set → any other tenant throws `tenant-forbidden`.

## Storage scoping

Migration `0011_tenants.sql` adds a `tenants` table and a `tenant_id` column
(`NOT NULL DEFAULT 'default'`) to `owners`, `documents`, `passages`,
`passage_embeddings`, `requests`, `answers`, `feedback`, `episodes`, `jobs`,
and `usage_ledger`, plus tenant-first indexes. Existing rows belong to the
`default` tenant — the single-owner scope — so pre-#120 code keeps working.

`new Repositories(client, { tenantId })` binds a repository aggregate to one
tenant and **every** query it issues filters on `tenant_id`; `repos.forTenant(id)`
derives a sibling scope on the same connection. The default is the `default`
tenant. Tenant ids are validated before any SQL runs (`TenantScopeError`), and
reads on another tenant's rows return `undefined`/`[]`; linking writes
(passage → document, answer → request, feedback → answer) refuse with
`not owned by` because their parent lookup is tenant-scoped.

FTS (`passages_fts`) carries no tenant column by design; the retrieval join
re-checks `passages.tenant_id` and `documents.tenant_id`, so the mirror can
never widen a tenant's result set. `searchPassages`, `searchByEmbedding`,
`hybridSearch`, `storePassageEmbeddings`, and `backfillPassageEmbeddings`
take a trailing `tenantId` (default `default`).

Not yet tenant-scoped: `BudgetService` and `JobQueue` still operate on the
`default` tenant's rows (columns exist, filters are a follow-up recorded in
`plans/019-multi-tenant-auth.md`).

## Capability grants per user and tenant

`Kernel.grantScoped({ tenantId, ownerId? }, plugin, ...capabilities)` records a
grant for one tenant (tenant-wide) or one owner inside a tenant.
`kernel.activate(name, { principal })` adds only the scoped grants that match
the caller before the INV-003 check; `kernel.effectiveGrants(name, principal)`
is the read-only view. `kernel.grant(...)` remains the instance-wide legacy
door and still applies to every caller (owner-allowlist mode). Grant-requiring
plugins remain refused outright in `ci`.

## Wiring a deployment

```ts
const provider = new OidcPrincipalProvider({
  verifier: new JwksOidcVerifier({ issuer, audience, jwksUrl }),
  tenantClaim: "tenant_id",
  rolesClaim: "roles",
});
const principal = await provider.authenticate({ token: bearer });
const repos = repositories.forTenant(principal.tenantId);
```

The packaged service (`apps/server`) still authenticates owners through
`AuthService` and runs on the `default` tenant; switching its request path to
`AuthProvider` + per-request `forTenant` scoping is the remaining integration
step tracked in `plans/019-multi-tenant-auth.md` (it needs the server runtime's
single shared repository aggregate to become request-scoped).

## Threat notes

- Cross-tenant reads/writes are covered by `tests/security/cross-tenant.test.ts`
  (quality gate) and `packages/storage/test/tenant-isolation.test.ts`.
- Tenant ids come from verified claims only and are parameterised into SQL —
  never interpolated.
- A dev-bypass request resolves to the configured default tenant; it cannot
  select a tenant from the wire.
- Owner ids stay globally unique (`owners.id` is the primary key); a tenant is
  an additional boundary, not a replacement for owner scoping.
