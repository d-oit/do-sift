# ADR 0010 — Multi-tenant authentication behind a pluggable `AuthProvider`

Status: accepted 2026-11-01 (#120)

## Context

CORE-04 shipped a deliberately single-owner auth model: a verified OIDC
id-token subject must appear on an owner allowlist (timing-safe compare), and
a loopback-only dev bypass exists for local work. That is right for a
single-owner deployment behind loopback/TLS, but it blocks teams, shared
instances, and any workspace isolation requirement. The gap is structural, not
a bug: there is no tenant concept in the schema, no provider seam in the
kernel, and no per-user/per-tenant capability evaluation.

Constraints that shape the decision:

- AGENTS.md ground rules: plugins never receive raw `fs`/`net`; every plugin
  needs a manifest, declared capabilities, and tests; `paid`/`computer`/
  `browser` capabilities need recorded grants and stay disabled in CI.
- The product promise ("research with receipts") requires that evidence and
  runs cannot cross a tenant boundary by accident — a leak is a
  correctness failure, not a policy preference.
- The existing owner-allowlist deployment must keep working; breaking it
  would strand every current install and its tests.

## Decision

1. **Abstract the auth layer in `packages/contracts` (`auth.ts`).** `TenantId`,
   `Principal`, `AuthProvider`, `AuthProviderError`, and
   `assertSameTenant` are the only types the kernel and storage depend on.
2. **Ship two providers.** `AllowlistAuthProvider` wraps the existing
   `AuthService` as the fallback (tenant = `default`, or a configured
   `tenantClaim`); `OidcPrincipalProvider` maps verified OIDC claims to a
   tenant-scoped `Principal`. The latter is packaged as the reference
   `auth`-kind plugin `@do-sift/plugin-auth-oidc` (new `PluginKind` member),
   declaring only `network` and constrained to its manifest host.
3. **Add `tenant_id` to storage (migration 0011) and scope at the query
   layer.** Every repository instance is bound to one tenant; reads filter,
   writes stamp, linking lookups are tenant-scoped, and the FTS retrieval join
   re-checks tenant ownership. Existing rows default to `default`, so the
   single-owner deployment is bit-identical.
4. **Evaluate capabilities per caller.** `Kernel.grantScoped({tenantId,
ownerId?}, ...)` records tenant/per-user grants; `activate(name,
{principal})` counts only matching scoped grants plus the legacy
   instance-wide set. CI keeps refusing grant-requiring plugins outright.

## Consequences

- Cross-tenant leakage is now a tested invariant
  (`tests/security/cross-tenant.test.ts`), including the answer path and
  capability grants, using the _same_ owner id in two tenants so the owner
  filter cannot mask a tenant-scope regression.
- Plugin authors get a documented `auth` kind; identity implementations are
  swappable without touching the kernel.
- `BudgetService` and `JobQueue` remain `default`-tenant only; the packaged
  server still authenticates through `AuthService` and uses one repository
  aggregate. Both are recorded follow-ups in `plans/019-multi-tenant-auth.md`
  and are honest limitations of this slice, not silent gaps.
- SAML is not implemented: the issue proposed "OIDC/SAML". OIDC covers the
  stated need with the existing crypto-only verifier; a SAML provider is a
  new `AuthProvider` implementation with no changes to the interfaces chosen
  here.

## Alternatives considered

- **Per-request tenant via a SQL-rewriting client proxy.** Rejected: fragile
  and impossible to review safely; explicit scoped repositories keep the SQL
  auditable.
- **Making `Repositories` tenant-mandatory with no default.** Rejected: it
  would churn every caller and every test for no security gain, since the
  `default` tenant is the legacy scope by definition.
- **Tenant-scoped tables per tenant (schema-per-tenant).** Rejected: SQLite
  /libSQL has one schema; row-level scoping with mandatory filters is the
  idiomatic fit and keeps migrations linear.
