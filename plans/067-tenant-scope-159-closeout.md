# Plan 067 — Tenant-scope closeout for issue #159

Status: in-progress (closeout sweep, 2026-11-26). Owner: maintainer.
Issue #159 asked that tenant scope be mandatory at low-level storage
boundaries. The implementation already landed as `ba1a020` (PR #175,
merged 2026-11-16) with no plan-file evidence record — this plan is that
record, plus a verification sweep on current `main` before closing the
issue. No code changes: every criterion below is verified against the
merged implementation.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                                       | Preconditions               | Sensor  |
| ----- | ---------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| TS-01 | Confirm static guard + runtime fail-closed on current main (`tenant-scope-required`, `cross-tenant-scope`) | Plan row exists (this file) | `tests` |
| TS-02 | Map each #159 acceptance criterion 1:1 to merged evidence (caches, admin paths, globals, compat)           | TS-01 green                 | `tests` |
| TS-03 | Gates: `npm run check:fast`, `npm run eval:offline`, signals feedback; evidence here                       | TS-01..02 green             | `evals` |
| TS-04 | Close #159 with an evidence comment citing this plan and the merged commit                                 | TS-01..03 green             | —       |

Out of scope: new tenant features, changing the explicit-`default`
constructor binding, per-tenant deployment work (not a product rollout).

## Decision notes

- Implementation reference: `ba1a020` ("security(storage): require
  explicit tenant scope at low-level boundaries (#159) (#175)").
  `searchPassages` / `searchByEmbedding` / `hybridSearch` /
  `getExistingModelDimension` / `storePassageEmbeddings` /
  `backfillPassageEmbeddings` / `backfillPassageNoiseClasses` /
  retention options all take REQUIRED `tenantId: string` and open with
  `assertTenantScope`; unscoped SQL fallback fragments were removed.
- `Repositories`, `BudgetService`, `JobQueue`, `synthesis-log` and
  `collections` keep the constructor-level `= DEFAULT_TENANT_ID`
  binding. That is the "explicit `default` binding" #159's own
  criterion 6 allows — the ban is on implicit SQL fallbacks that omit
  the tenant predicate, which the guard test pins absent.
- Two-way binding (plan 035 shape) is preserved: the explicit scope must
  agree with the owners-row derivation, so a wrong-tenant runtime finds
  nothing instead of reading another tenant's rows.
- Caches: the exact-answer cache is `Repositories.answers.findByCacheKey`,
  tenant-bound by construction; wrong-tenant lookup is pinned in
  `tests/security/cross-tenant.test.ts:203`.
- Admin paths: `membership-admin` derives the tenant from the
  authenticated principal (`owner.tenantId`), never from URL/body/query
  input — there is no cross-tenant id to tamper with (file header
  documents this; global registry surfaces stay global by design and are
  asserted as such in the guard test).
- Method: closeout verification. No spike: no uncertain API involved.

## Evidence

- `npx vitest run -c vitest.unit.config.ts
tests/security/tenant-scope-required.test.ts
tests/security/cross-tenant-scope.test.ts` — 2 files, 17 tests, all
  pass on current `main` (`a1a334b`).
- `npx vitest run packages/analytics` — 26/26 pass (same HEAD; #157
  reports unaffected).
- `npm run eval:offline` — PASS (42 deterministic cases, 0 external
  network calls, 0 paid model calls) on the same HEAD.
- `npm run check:fast` — PASS 9/9 (run for this closeout; pre-push hook
  runs the full 12/12 set before merge).
- `npm run signals -- verify --set feedback` — green (first run was red on
  `format`: this plan file needed `prettier --write`; re-ran green after
  the fix, no sensor edits).
- review-security: no new trust boundary (docs-only change); the tenant
  remains an authorization boundary enforced at the storage layer, never
  accepted from HTTP input. Residual: `tenants.ensure/get` remain
  globally addressable by design (registry, not tenant data); per-tenant
  deployments must not expose them to principals — recorded in
  `docs/multi-tenant-auth.md`.
