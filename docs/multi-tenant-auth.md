# Multi-tenant authentication

Status: implemented (issue #120, plan 024, MT-01…MT-08). Tenant scoping covers
the query layer and the schema, tenant membership gates both capability grants
and runtime selection, and one process can serve a configured tenant set. The
single-owner allowlist remains the default posture; read [Limits](#limits)
before exposing a shared instance.

## The contract

`packages/contracts/src/auth.ts` defines the only things the kernel and the
server know about authentication:

```ts
type AuthMode = "owner-allowlist" | "multi-tenant";

interface AuthPrincipal {
  tenantId: string; // scopes every storage statement
  userId: string; // the person inside that tenant
  roles: readonly string[]; // advisory labels — they grant nothing
}

interface AuthProvider {
  id: string;
  mode: AuthMode;
  authenticate(request: { token?: string; clientAddress?: string }): Promise<AuthPrincipal>;
}
```

Rules the interface encodes:

- **A provider either resolves a complete principal or throws.** There is no
  partial result, no unverified subject, and no implicit tenant.
- **Tenants come from the provider, never from the caller.** Handlers pass
  what the provider returned into storage; they never accept a tenant id from
  a request body, query string, or header.
- **Roles are labels.** Capability decisions go through
  `Kernel.authorizeForPrincipal`, which consults recorded grants only.

Two implementations ship:

| Provider                     | Package                     | Mode              | Tenant source                                             |
| ---------------------------- | --------------------------- | ----------------- | --------------------------------------------------------- |
| `OwnerAllowlistAuthProvider` | `@do-sift/auth`             | `owner-allowlist` | one configured tenant, default `default`                  |
| `createOidcAuthPlugin`       | `@do-sift/plugin-auth-oidc` | `multi-tenant`    | the `tenant` claim (configurable), or an explicit default |

The OIDC plugin declares zero capabilities: token verification and JWKS
transport are delegated to the injected `OidcVerifier` (`JwksOidcVerifier`
in production), so the plugin performs no I/O of its own. Its failures are
`AuthError` kinds: `authentication-required`, `invalid-token`,
`tenant-claim-missing`, `tenant-not-allowed`.

## Tenant scoping

Migration `0011_tenants.sql` adds:

- `tenants` and `tenant_members` (who may act inside which tenant, with a
  role), and
- a `tenant_id` column on every owner-scoped table, backfilled to `default`.

`Repositories`, `BudgetService`, and `JobQueue` are constructed **bound to one
tenant** (`new Repositories(client, tenantId)`). Every statement filters by
`tenant_id` and `owner_id`, and every insert stamps both. Retrieval and
embedding queries derive the tenant from the authoritative `owners` row, so
no caller-supplied tenant is ever trusted.

The database enforces the same rule independently: `BEFORE INSERT` /
`BEFORE UPDATE` triggers abort any row whose `(tenant_id, owner_id)` pair does
not match an `owners` row. A scoped repository handed a foreign owner id fails
loudly instead of filing data under the wrong tenant.

Owner ids are globally unique (`owners.id` is the primary key), so an owner
belongs to exactly one tenant and cannot be claimed by a second one.

## Grants per tenant and per user

`Kernel` now keeps a `PrincipalGrants` registry:

```ts
kernel.grantTenant("acme", "paid"); // every user of acme
kernel.grantUser("acme", "user-1", "browser"); // exactly one user

kernel.authorizeForPrincipal("model-router", { tenantId: "acme", userId: "user-1" }, "paid");
// → { allowed: boolean, reason: "tenant-grant" | "user-grant" | "not-granted" }
```

Authorization requires **three** gates: the plugin must declare the
capability and hold its own activation grant (INV-003, unchanged), the user
must be a member of the tenant it claims (see
[Membership](#membership-who-may-act-in-a-tenant)), and the principal must
hold a tenant or user grant. A grant for tenant A is invisible to tenant B,
even for the same user id string. Nothing is inferred from roles.

`authorizeForPrincipal` is `async` because membership is stored state; an
un-awaited call has no `allowed` field, so a forgotten `await` denies.

## Deployment postures

| Posture                | Auth                                            | Storage                                                         | Notes                                          |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Single owner (default) | `OwnerAllowlistAuthProvider` + `DO_SIFT_OWNERS` | tenant `default`                                                | unchanged behaviour, no tenant claim needed    |
| Shared instance        | `plugin-auth-oidc` with an `OidcVerifier`       | one scoped `Repositories`/`BudgetService`/`JobQueue` per tenant | `DO_SIFT_TENANTS` + membership rows, see below |

## Membership (who may act in a tenant)

`tenant_members` is authoritative: a user's role inside a tenant. It is not
advisory bookkeeping — two places consult it before any tenant data is
reached:

- **The grant path.** `Kernel.authorizeForPrincipal` checks membership before
  it considers any grant and answers
  `{ allowed: false, reason: "not-a-member" }` otherwise. Hosts wire the
  directory at startup with `KernelOptions.membership` or
  `kernel.useMembership(...)`; without one, grants alone decide (the
  pre-membership behaviour, so single-tenant hosts are unchanged).
- **The runtime path.** `resolvePrincipalRuntime` refuses a non-member, so a
  verified token whose tenant claim names another tenant cannot obtain that
  tenant's runtime or data.

`TenantMembershipDirectory` (`@do-sift/storage`) is the storage-backed
directory: `add(tenantId, userId, role)`, `remove`, `roleOf`, `members`,
`tenantsOf`. Reads fail closed — unknown tenant, unknown user, empty id, or an
undefined role all mean "not a member" — and writes refuse unknown tenants,
empty ids, and unknown roles, because those are operator bugs rather than
requests.

## Managing memberships (operator surface)

Multi-tenant mode exposes a small authenticated admin surface. The tenant is
**the caller's own tenant** — never read from the URL, body, or query string,
so there is no cross-tenant id to tamper with — and authority is the stored
membership role, not a token claim:

| Request                                              | Effect                           |
| ---------------------------------------------------- | -------------------------------- |
| `GET /api/admin/members`                             | list the caller's tenant members |
| `PUT /api/admin/members/<userId>` body `{"role": …}` | add or re-role a membership      |
| `DELETE /api/admin/members/<userId>`                 | remove a membership              |

The rules:

- **Every change is logged and reviewable.** `GET /api/admin/member-changes`
  returns the newest 50 changes of the caller's own tenant: actor, target,
  action (`added`, `role-changed`, `removed`), from/to role, and timestamp.
  The row is written in the same transaction as the membership write and is
  never updated or deleted, so it is an audit trail rather than a cache. A
  request that re-sends the role a member already has writes and logs
  nothing; writes made outside this surface (operator scripts calling
  `TenantMembershipDirectory.add`) are recorded with actor `system`.
- **401 without a valid token; 403 for everyone who is not a recorded
  `owner` of that tenant.** Members, viewers, and non-members get the same
  `forbidden` answer, so the surface never discloses who belongs where.
- **The caller's own row is read-only here.** An owner cannot change or
  remove their own membership, which keeps every tenant with at least one
  owner; an owner may still demote _another_ owner.
- **Bodies are strict:** exactly `{"role": "owner" | "member" | "viewer"}`,
  capped at the research routes' `maxBodyBytes`; anything else is `400`.
- **Missing rows are honest:** `DELETE` of a non-member answers `404`, and
  the operation reports whether a row was removed.
- **Absent unless wired:** without `ResearchServerOptions.membershipAdmin`
  (the single-tenant posture) these paths are ordinary `404`s.

Admin requests share the caller's `tenant/user` admission budget.

## One process, several tenants

`apps/server` serves a configured tenant set with:

```
DO_SIFT_TENANTS=acme,globex
DO_SIFT_OIDC_ISSUER=… DO_SIFT_OIDC_AUDIENCE=… DO_SIFT_OIDC_JWKS_URL=…
```

Startup refuses a half-configured deployment: the OIDC trio is required (the
allowlist door cannot name a tenant), `DO_SIFT_DEV_BYPASS` is refused (it has
no tenant claim), and tenant ids must be 1-64 characters of `[A-Za-z0-9._-]`.
With that configured:

1. each tenant is ensured in `tenants` at boot; membership rows are **not**
   seeded — granting access is an explicit operator act;
2. `createRuntimeResolver` builds one tenant-bound runtime per tenant, lazily,
   sharing the client, search adapter, fetch path, model, and embedder, and
   refuses tenants outside the set;
3. `resolvePrincipalRuntime` checks membership, then hands back that tenant's
   runtime; a refusal is HTTP `403` (nothing about tenant existence leaks);
4. admission limits are keyed `tenant/user`, so one tenant's traffic cannot
   consume another tenant's quota.

Runtimes are memoized and bounded (`DEFAULT_MAX_RESOLVED_TENANTS`, 32);
exceeding the bound is refused rather than silently evicting live runtimes.

## Limits

- **Owner ids are global, so one person needs one id per tenant.** Data rows
  hang off `owners.id`, a global primary key, so one human cannot own evidence
  in two tenants under a single id. Multi-tenant hosts issue per-tenant owner
  ids (for example `acme:user-1`) or keep one tenant per person.
- **Roles narrow what an admitted member may do.** The role comes from the
  `tenant_members` row — never from the token's `roles` claim — and a missing
  row allows nothing.

  | Role     | `read` (`/`, `/metrics`) | `research` (`POST /api/research`, `POST /api/answer`) | `admin` (`/api/admin/*`) |
  | -------- | ------------------------ | ----------------------------------------------------- | ------------------------ |
  | `viewer` | yes                      | no                                                    | no                       |
  | `member` | yes                      | yes                                                   | no                       |
  | `owner`  | yes                      | yes                                                   | yes                      |

  A refused run answers `403` before the tenant runtime is resolved, so no
  budget is reserved, no evidence is written, and the refusal costs nothing.
  Hosts opt in through `ResearchServerOptions.roleFor`; without it (the
  single-tenant allowlist posture) the role gate does not apply.

- **A viewer can still read.** `GET /api/evidence` and `GET /api/answers`
  (MT-13) list the caller's own newest sources and answers inside their
  tenant, which is what makes `viewer` a usable role rather than a lockout.
  Both are owner- and tenant-scoped from the authenticated principal, return
  provenance only (no page text, no answer blocks or token usage), and never
  reserve budget. See `docs/api.md`.

- **Owners are peers.** The admin surface lets an owner appoint another
  owner; there is no separation of duties and no approval step. Treat `owner`
  as full control of that tenant's evidence.
- **The change log is a review aid, not tamper-evident.** It is append-only in
  application code and tenant-scoped on read, but anyone with database write
  access can rewrite it; it is not a signed ledger. Reads return the newest 50
  rows per tenant; older rows stay in the table until an operator prunes them
  with `retention prune-changes --tenant <id>` (one tenant per run, dry-run
  unless `--confirm`, 365-day default, 30-day floor — see
  `docs/deployment.md`).
- **`plans/invariants.json` has no tenant invariant.** Adding `INV-008`
  (cross-tenant isolation) is an owner-approved change to that file; the
  enforcement already runs in `npm run check`
  (`tests/security/cross-tenant.test.ts`,
  `packages/server/test/tenant-routing.test.ts`,
  `packages/storage/test/membership.test.ts`).
