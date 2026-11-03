# 024 — Multi-tenant / multi-user authentication (issue #120)

Status: done (2026-11-03), MT-01…MT-14 complete. One owner-gated change
(INV-008 in `plans/invariants.json`) remains recorded under Risks.

Issue #120 asked for a pluggable auth layer, an OIDC reference plugin, tenant
scoping in storage, per-user/per-tenant capability evaluation, a
cross-tenant leakage test, and the owner-allowlist mode preserved as a
fallback. This plan is that slice.

## Task rows

| ID    | Task                                                              | Status | Acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MT-01 | `AuthProvider` + `AuthPrincipal` contract in `packages/contracts` | done   | `packages/contracts/src/auth.ts` (documented interface, zod principal schema, `DEFAULT_TENANT_ID`); contract exported from `packages/contracts/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| MT-02 | OIDC auth provider plugin with tenant-claim mapping               | done   | `packages/plugins/plugin-auth-oidc` (`plugin.json` kind `auth`, zero capabilities), `src/index.ts`; tenant claim → principal, fail-closed on missing/unpermitted tenant                                                                                                                                                                                                                                                                                                                                                                            |
| MT-03 | Tenants in the storage schema + query-layer scoping               | done   | `migrations/0011_tenants.sql` (tenants, tenant_members, tenant_id columns, consistency triggers); `Repositories`/`BudgetService`/`JobQueue`/retention bound to one tenant; retrieval + embeddings derive the tenant from the owners row                                                                                                                                                                                                                                                                                                            |
| MT-04 | Capability grants per user and per tenant                         | done   | `packages/kernel/src/grants.ts` (`PrincipalGrants`), `Kernel.grantTenant` / `Kernel.grantUser` / `Kernel.authorizeForPrincipal` requiring both the plugin grant (INV-003) and the principal grant                                                                                                                                                                                                                                                                                                                                                  |
| MT-05 | Cross-tenant leakage test in the quality gate                     | done   | `tests/security/cross-tenant.test.ts` — evidence, answers/cache, retrieval, budget ledger, job queue, retention, schema triggers, and auth→storage wiring                                                                                                                                                                                                                                                                                                                                                                                          |
| MT-06 | Owner-allowlist fallback preserved and documented                 | done   | `OwnerAllowlistAuthProvider` in `@do-sift/auth` (default tenant `default`); `docs/multi-tenant-auth.md`; deployment notes updated                                                                                                                                                                                                                                                                                                                                                                                                                  |
| MT-07 | Enforce `tenant_members` in the grant path                        | done   | `MembershipDirectory` + `TenantRole` in `packages/contracts/src/auth.ts`; `TenantMembershipDirectory` in `packages/storage/src/membership.ts`; `Kernel.authorizeForPrincipal` is now async and answers `not-a-member` before any grant (`packages/kernel/test/grants.test.ts`, `packages/storage/test/membership.test.ts`)                                                                                                                                                                                                                         |
| MT-08 | Per-principal runtime resolver + multi-tenant HTTP serving        | done   | `createRuntimeResolver` / `resolvePrincipalRuntime` / `TenantAccessError` in `packages/server/src/runtime-resolver.ts`; `ResearchServerOptions.runtimeFor` + 403 on refusal; `DO_SIFT_TENANTS` wiring in `apps/server` (OIDC trio required, dev bypass refused); `packages/server/test/tenant-routing.test.ts`                                                                                                                                                                                                                                     |
| MT-09 | Membership administration surface (list / add / re-role / remove) | done   | `handleMembershipAdmin` in `packages/server/src/membership-admin.ts`; routes `GET /api/admin/members`, `PUT /api/admin/members/<userId>`, `DELETE /api/admin/members/<userId>`; tenant from the principal, authority from the stored role, self-edit lockout guard; wired in `apps/server` only for multi-tenant mode; `packages/server/test/membership-admin.test.ts`                                                                                                                                                                             |
| MT-11 | Retention policy and pruning path for the change log              | done   | `MIN_MEMBER_CHANGE_RETENTION_DAYS` / `DEFAULT_MEMBER_CHANGE_RETENTION_DAYS` and `pruneMemberChangeLog` in `packages/storage/src/retention.ts` (tenant-scoped, dry-run, 30-day floor on both `retentionDays` and an explicit cutoff, transactional delete); `retention prune-changes --tenant <id>` in `apps/cli`; `packages/storage/test/retention.test.ts`, `apps/cli/test/cli.test.ts`                                                                                                                                                           |
| MT-10 | Membership change log for owners (audit trail)                    | done   | `migrations/0012_tenant_member_changes.sql` (append-only `tenant_member_changes`); `TenantMembershipDirectory.add`/`remove` log actor plus before/after role in the same transaction; `GET /api/admin/member-changes`; `packages/storage/test/membership.test.ts`, `packages/server/test/membership-admin.test.ts`                                                                                                                                                                                                                                 |
| MT-12 | Roles as policy: viewer is read-only                              | done   | `roleAllows` / `TENANT_ROLE_ACTIONS` in `packages/contracts/src/auth.ts` (owner: read+research+admin, member: read+research, viewer: read; absent role allows nothing); `ResearchServerOptions.roleFor` gate in `packages/server/src/server.ts` refusing `POST /api/research` and `POST /api/answer` with 403 before runtime resolution; wiring in `apps/server/src/main.ts`; `packages/contracts/test/tenant-roles.test.ts`, `packages/server/test/role-policy.test.ts`                                                                           |
| MT-14 | Paged read surface (cursor paging past the newest page)           | done   | `ReadCursor` + `before` on `ReadHandlers` in `packages/server/src/server-contracts.ts`; opaque `?cursor=` encode/parse in `packages/server/src/read-surface.ts` (`400` on anything it did not issue, `nextCursor` only when another page exists); `documents.listPage` (ordered by `fetched_at`) and `answers.list(before)` (ordered by `created_at`) in `packages/storage/src/repositories.ts`, both owner- and tenant-scoped with an id tie-breaker; 5 paging cases in `packages/server/test/read-surface.test.ts`; `docs/api.md` Paging section |
| MT-13 | Read-only evidence and answer surface for viewers                 | done   | `packages/server/src/read-surface.ts` (`GET /api/evidence`, `GET /api/answers`, `limit` 1-50 validated, owner and tenant from the principal, `read` action gate); `ResearchServerOptions.readFor` wired in `apps/server/src/main.ts` from tenant-bound `Repositories`; `repositories.answers.list` joins the question through the request row; `packages/server/test/read-surface.test.ts`; `docs/api.md`                                                                                                                                          |

## Invariants touched

- **INV-003** (paid/computer grants cannot activate without a recorded grant):
  unchanged. `authorizeForPrincipal` adds a second gate and never bypasses
  the activation gate.
- **INV-007** (site-access default-deny): untouched.
- No invariant was added: `plans/invariants.json` is an owner-approved change
  (AGENTS.md → Approval boundaries). MT-05 is the enforcing test for the
  would-be `INV-008`; recording it in `plans/invariants.json` is the
  remaining owner step.

## Design notes

- **Tenant comes from the principal, never from the request.** Providers
  return a validated `AuthPrincipal`; handlers pass its `tenantId` into a
  tenant-bound repository handle.
- **Two enforcement layers, on purpose.** The query layer filters on
  `tenant_id` + `owner_id`; the schema aborts any write whose
  `(tenant_id, owner_id)` pair does not match an `owners` row. A caller bug
  therefore fails closed instead of misfiling data.
- **`default` tenant keeps upgrades a no-op.** Migration 0011 backfills every
  existing row to `default`, and every scoped class defaults to it — the
  single-owner allowlist deployment behaves exactly as before.
- **Retrieval derives the tenant.** `searchPassages` and the embedding
  searches resolve the tenant from the authoritative `owners` row, so no
  new caller-supplied tenant parameter can be spoofed from a request.

## Evidence (commands run + results)

Run on 2026-11-02 in the chat worktree, Node 26 / npm 11.

| Command                                    | Result                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install --no-audit --no-fund`         | exit 0 — 225 packages; the only lockfile change is the new workspace package `@do-sift/plugin-auth-oidc` (no dependency upgrades)                                                                     |
| `npx vitest run`                           | exit 0 — **78 test files, 0 failures**, 13 skipped; includes `tests/security/cross-tenant.test.ts`, `packages/kernel/test/grants.test.ts`, `packages/plugins/plugin-auth-oidc/test/auth-oidc.test.ts` |
| `npm run check`                            | exit 0 — `prettier`, `eslint`, `typecheck`, `policy`, `skills`, `governance`, `tests`, `evals`, `build` all PASS (9/9)                                                                                |
| `npm run signals -- verify --set feedback` | exit 0 — verdict `green`; receipt `.do-harness/evidence.feedback.json` (format, lint, typecheck, policy, skills, governance)                                                                          |

Failures hit and fixed during the loop (recorded because they are the kind
that recur): `DEFAULT_TENANT_ID` imported from `rows.ts` instead of
`@do-sift/contracts` (named import resolved to `undefined`, so the default
parameter never applied); `JobQueue` assigning `tenantId` as a field
initializer that runs before the parameter property `this.options` exists;
the 0009-upgrade embeddings test writing through the current writer against a
pre-0009 schema (now writes the legacy row with raw SQL); a sync throw
asserted with `rejects` instead of `toThrow`.

### MT-09 follow-up run (2026-11-02, same worktree)

| Command                                       | Result                                                                                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx prettier --write` + `npm run check:fast` | exit 0 — 6/6 after fixing the un-narrowed member id in the admin handler and the missing `server.ts` type re-exports                                                                                                                                  |
| `npx vitest run packages/server`              | exit 0 — 11 files; 14 new cases cover listing, add/re-role/remove, tenant isolation, 403 for member/viewer/stranger, 401, 400 for bad roles and self-edits, 404 for missing rows, 405/allow headers, nested and `%2F` ids, and the absent-surface 404 |
| `npm run check`                               | exit 0 — all 9 steps PASS                                                                                                                                                                                                                             |

### MT-10 follow-up run (2026-11-02, same worktree)

| Command                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                                                | exit 0 — the sandbox had dropped `node_modules`; reinstalled from the existing lockfile, no dependency or version changes                                                                                                                                                                                                                    |
| `npm run check:fast`                                                                                    | exit 0 — 6/6                                                                                                                                                                                                                                                                                                                                 |
| `npx vitest run packages/storage/test/membership.test.ts packages/server/test/membership-admin.test.ts` | exit 0 — 2 files; storage gains 4 change-log cases (order and before/after roles, no-op plus missing row logs nothing, tenant split plus `system` actor, capped history) and the server gains 5 history cases (audited add/re-role/remove, no-op suppression, refusals logged nothing, tenant isolation, and the same 401/403/405/404 rules) |
| `npm run check`                                                                                         | exit 0 — all 9 steps PASS                                                                                                                                                                                                                                                                                                                    |
| `npm run signals -- verify --set feedback`                                                              | exit 0 — verdict green                                                                                                                                                                                                                                                                                                                       |

Risks recorded for MT-10: the log is append-only in code but not tamper-evident (database write access can rewrite it); reads return the newest 50 rows per tenant while older rows stay in the table until pruned; writes made outside the admin surface are attributed to `system`. MT-11 adds the pruning path.

### MT-14 follow-up run (2026-11-03, same worktree)

| Command                                                                                               | Result                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run packages/server/test/read-surface.test.ts packages/storage/test/repositories.test.ts` | exit 0 — 2 files; 13 read-surface cases (8 from MT-13 plus 5 paging: full walk without repeats, answers paged with their questions, no `nextCursor` on an exactly full page, malformed cursor `400`, borrowed cursor stays inside the caller's rows) and the storage suite unchanged |
| `npm run check`                                                                                       | exit 0 — all 9 steps PASS                                                                                                                                                                                                                                                            |
| `npm run signals -- verify --set feedback`                                                            | exit 0 — verdict green                                                                                                                                                                                                                                                               |

One test failed first and was corrected, not weakened: the borrowed-cursor case
expected an empty page, but a cursor older than the caller's own newest row
legitimately selects that row. The assertion now states the real invariant — a
cursor moves the window, it never widens it beyond the authenticated owner —
and checks the returned ids rather than merely counting them.

### Status reconciliation run (2026-11-03, same worktree)

No code changed: this pass only made the recorded state match MT-01…MT-13. The
plan's Handoff still said MT-07 was deferred and the risk list still claimed
roles were "recorded, not policy" and that no membership admin surface existed
— all three were closed by MT-07/MT-09/MT-10/MT-12. Each carried-forward risk
now states whether a later row closed it, the Handoff lists the files the later
rows added, and `plans/README.md` no longer describes roles as recorded-only.
The risks that survive (global owner ids, owner-scoped reads, missing per-user
cap configuration, the heavy 0011 migration, `INV-008` ownership) are the ones
the code still does not fix.

| Command              | Result            |
| -------------------- | ----------------- |
| `npm run check:fast` | exit 0 — 6/6 PASS |

### MT-13 follow-up run (2026-11-03, same worktree)

| Command                                                                                                                                           | Result                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:fast`                                                                                                                              | exit 0 — 6/6                                                                                                                                                                                                                                                    |
| `npx vitest run packages/server/test/read-surface.test.ts packages/server/test/role-policy.test.ts packages/server/test/membership-admin.test.ts` | exit 0 — 3 files; 8 new read-surface cases (viewer lists own evidence and own answers, member sees only its own rows, stranger 403, missing token 401, `limit` 1/0/500/abc, 405 with `allow: GET`, absent surface 404); role-policy and admin suites unaffected |
| `npm run check`                                                                                                                                   | exit 0 — all 9 steps PASS                                                                                                                                                                                                                                       |
| `npm run signals -- verify --set feedback`                                                                                                        | exit 0 — verdict green                                                                                                                                                                                                                                          |

Failures hit and fixed: `handleReadRoute` was handed `options.readFor` (a principal → handlers
factory) where handlers were expected, which typecheck caught; the route now admits the caller,
then resolves tenant-bound handlers, so a refused caller never reaches storage. The first run then
answered `404` for both new paths because `requestPath` keeps a fixed route vocabulary and collapses
anything else to `/unmatched`; `/api/evidence` and `/api/answers` are now in that vocabulary, which is
what keeps dispatch and the request receipts on the same list of routes.

### MT-12 follow-up run (2026-11-03, same worktree)

| Command                                                                                                                                              | Result                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                                                                                             | exit 0 — the sandbox dropped `node_modules` again mid-session; reinstalled from the existing lockfile (no version changes)                                                                                                                                                                                            |
| `npm run check:fast`                                                                                                                                 | exit 0 — 6/6, after the contracts policy, the server gate, and the `apps/server` wiring typechecked                                                                                                                                                                                                                   |
| `npx vitest run packages/contracts/test/tenant-roles.test.ts packages/server/test/role-policy.test.ts packages/server/test/membership-admin.test.ts` | exit 0 — 3 files; 5 new contracts cases (viewer/member/owner matrices, absent role, exhaustive pairs) and 6 new HTTP cases (viewer 403 on research and answer with no run or answer executed, stranger 403, member/owner 200, legacy server without `roleFor` still 200, unauthenticated 401), admin suite unaffected |
| `npm run check`                                                                                                                                      | exit 0 — all 9 steps PASS                                                                                                                                                                                                                                                                                             |
| `npm run signals -- verify --set feedback`                                                                                                           | exit 0 — verdict green                                                                                                                                                                                                                                                                                                |

No implementation failure this slice; the only interruption was the dropped dependency tree. The gate sits
between authentication and runtime selection, so a refused viewer never triggers tenant runtime construction,
budget reservation, or a storage write — the refusal is cheap and leaves no trace beyond the request receipt.

### MT-11 follow-up run (2026-11-03, same worktree)

| Command                                                                            | Result                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci`                                                                           | exit 0 — the sandbox had dropped `node_modules` again; reinstalled from the existing lockfile, no dependency or version changes                                                                                                                                                                                                                        |
| `npm run check:fast`                                                               | exit 0 — 6/6                                                                                                                                                                                                                                                                                                                                           |
| `npx vitest run packages/storage/test/retention.test.ts apps/cli/test/cli.test.ts` | exit 0 — 2 files; `retention.test.ts` 14 cases (5 new: tenant-scoped prune, dry-run counts, floor rejection for both window and cutoff, required tenant and window, yearly default plus idempotence) and `cli.test.ts` 26 cases (5 new: `--tenant` required, dry-run default, confirmed delete scoped to one tenant, floor rejection, `--out` receipt) |
| `npm run check`                                                                    | exit 0 — all 9 steps PASS                                                                                                                                                                                                                                                                                                                              |
| `npm run signals -- verify --set feedback`                                         | exit 0 — verdict green                                                                                                                                                                                                                                                                                                                                 |

Failure hit and fixed: the first idempotency assertion expected a second run against the
2026-06-01 cutoff to delete nothing, but that cutoff also covers the January row; the test
now asserts that delete and then a genuinely empty third run.

### MT-07 / MT-08 follow-up run (2026-11-02, same worktree)

| Command                                    | Result                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install --no-audit --no-fund`         | exit 0 — added the `@do-sift/contracts` workspace link to `@do-sift/server`; no dependency version changes                                                                                                                                                                                          |
| `npm run check:fast`                       | exit 0 — prettier, eslint, typecheck, policy, skills, governance (6/6); failures hit and fixed: the `as ResearchServerOptions["runResearch"]` cast became optional, `delete` on a narrowly-typed options copy, and an excess `roles` property                                                       |
| `npx vitest run`                           | exit 0 — **80 test files, 0 failures**; new: `packages/server/test/tenant-routing.test.ts` (resolver isolation, unknown tenant, tenant cap, membership refusal, HTTP routing to 403), `packages/storage/test/membership.test.ts`, and the membership cases in `packages/kernel/test/grants.test.ts` |
| `npm run check`                            | exit 0 — all 9 steps PASS (prettier, eslint, typecheck, policy, skills, governance, tests, evals, build)                                                                                                                                                                                            |
| `npm run signals -- verify --set feedback` | exit 0 — verdict `green`                                                                                                                                                                                                                                                                            |

### MT-07 / MT-08 risks carried forward — closed or still open

Reviewed 2026-11-03 after MT-13; each bullet now says whether a later row
closed it.

- **Roles are recorded, not policy.** Closed by MT-12: `roleAllows` and the
  `roleFor` gate refuse a `viewer`'s `POST /api/research` and `POST /api/answer`
  with `403` before a runtime is resolved, and a caller with no membership row
  allows nothing at all.
- **Owner ids are global.** Still open. `owners.id` is a primary key, so one
  human cannot own evidence in two tenants under one id — multi-tenant hosts
  must issue per-tenant owner ids. Fixing this properly means rebuilding the
  owner-scoped tables with a composite `(tenant_id, id)` key: a migration with
  real downtime risk, deliberately not bundled here.
- **No membership admin surface.** Closed by MT-09 (list, add, re-role, remove,
  owner-only from the stored role) and MT-10 (an append-only change log the
  owner can read), with MT-11 adding the retention and pruning path.
- **Tenant cap is a refusal, not eviction.** Still open. Beyond
  `DEFAULT_MAX_RESOLVED_TENANTS` the resolver rejects rather than dropping a
  live runtime; operators must size the process deliberately.

## Handoff

- **Task:** MT-01 … MT-13 — done; no row in this plan is open. The one
  owner-gated step left is recording `INV-008` in `plans/invariants.json`
  (AGENTS.md → Approval boundaries), not code.
- **Files:** new — `packages/contracts/src/auth.ts`,
  `packages/kernel/src/grants.ts`, `packages/auth/src/provider.ts`,
  `packages/plugins/plugin-auth-oidc/` (package.json, plugin.json, src,
  test), `migrations/0011_tenants.sql`, `migrations/0012_tenant_member_changes.sql`,
  `packages/storage/src/membership.ts`, `packages/storage/src/retention.ts`,
  `packages/server/src/runtime-resolver.ts`,
  `packages/server/src/membership-admin.ts`,
  `packages/server/src/read-surface.ts`,
  `tests/security/cross-tenant.test.ts`, `docs/multi-tenant-auth.md`, this
  plan. Modified — `packages/contracts/src/index.ts`,
  `packages/kernel/{index,kernel,manifest}.ts`, `packages/auth/{auth,index}.ts`,
  `packages/storage/{repositories,budget,jobs,retention,retrieval,embeddings,rows}.ts`,
  `packages/storage/test/embeddings.test.ts`,
  `packages/server/src/{server,server-contracts,server-http,membership-admin}.ts`,
  `apps/server/src/main.ts`, `apps/cli`, `README.md`, `docs/{deployment,api}.md`,
  `plans/README.md`, `package-lock.json`.
- **Risks:** the four open items under Risks / open questions — owner ids
  remain global, reads are owner-scoped, per-user caps have no configuration
  surface, and the additive 0011 migration is heavy on a large database.
- **Next suggested task:** make the read surface reach further back than the
  newest 50 rows (paging), which MT-13's `limit` cap makes the practical
  ceiling today.

## Risks / open questions

- **Reads are owner-scoped.** MT-13 lists only the caller's own rows, so a
  `viewer` sees what that same user id stored and nothing a teammate stored in
  the same tenant. Tenant-wide reading is a privacy decision (may members read
  each other's corpora?) rather than a routing change, so it is left open.
- **Owner ids are global.** `owners.id` is a primary key: one human cannot own
  evidence in two tenants under one id.
- **Per-user caps.** Caps are enforced per (tenant, owner), which is the right
  unit, but no configuration surface exposes a per-user override inside one
  tenant yet.
- **Tenant cap is a refusal, not eviction.** Beyond
  `DEFAULT_MAX_RESOLVED_TENANTS` the resolver rejects rather than dropping a
  live runtime.
- **Migration weight.** 0011 adds eleven columns, ten indexes, and eighteen
  triggers. It is additive and defaulted, but a large production database
  will rewrite tables to add the NOT NULL-default columns; schedule it with
  the existing backup-before-migration ritual.
- **`INV-008` is an owner step.** MT-05 is the enforcing test for the
  would-be invariant; recording it in `plans/invariants.json` changes an
  approval-gated file and stays with the owner.
