# Plan 002 — CORE: contracts, storage, auth, budgets, safe-fetch

Status: done (2026-09-11 — CORE-10 consolidated security evidence closed the exit gate)

Goal: everything needed before real credentials exist: libSQL schema +
repositories, owner auth skeleton, atomic budgets, SSRF-safe fetch, job queue,
policy plugin, fake providers for tests.

Current status: closed. The detailed evidence and historical "next suggested"
notes below are retained; active production work is tracked in Plan 014.

## Tasks

| ID      | Task                                                                                                       | Status | Evidence           |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------ | ------------------ |
| CORE-01 | Numbered SQL migrations + schema_migrations table + migration runner                                       | done   | see evidence below |
| CORE-02 | Storage plugin (libSQL local file; Turso remote behind env config)                                         | done   | see evidence below |
| CORE-03 | Owner-scoped repositories (documents, passages, requests, answers, feedback, episodes, jobs, usage_ledger) | done   | see evidence below |
| CORE-04 | Auth: OIDC stub interface + owner allowlist + loopback-only dev bypass                                     | done   | see evidence below |
| CORE-05 | Budget service: atomic reserve/settle against usage_ledger                                                 | done   | see evidence below |
| CORE-06 | safe-fetch module: scheme/IP/redirect/DNS-rebinding/size/time/MIME guards                                  | done   | see evidence below |
| CORE-07 | Durable job queue with leases, retries, dead-letter                                                        | done   |                    |
| CORE-08 | plugin-policy-siteaccess: allowlist/denylist + robots/ToS registry + default-deny list                     | done   | see evidence below |
| CORE-09 | Fake model/search providers for offline tests                                                              | done   | see evidence below |
| CORE-10 | Security negative tests: SSRF variants, cross-owner access, budget bypass                                  | done   | see evidence below |

## Exit gate

All security negatives fail closed; owner isolation proven with a two-owner
fixture; zero real credentials anywhere in the repo or CI.

## CORE-06 evidence (2026-09-06)

**Files:** `packages/safe-fetch/` (new package: `src/guards.ts`,
`src/safe-fetch.ts`, `src/index.ts`, `test/safe-fetch.test.ts`,
`package.json`, `tsconfig.json`); `tsconfig.build.json` (added reference).

**Design:** pure guard functions (URL/IP classification, no I/O) plus an
orchestrator with injected DNS resolver and fetch implementation, so every
guard is tested offline (INV-006). Guard order per hop, redirects included:
WHATWG URL sanity (scheme, userinfo, IP-literal/local-host checks — the
parser canonicalizes decimal/hex IPv4 forms first) → DNS resolve → all
addresses must classify public (mixed answers fail closed, unparseable
addresses fail closed) → manual-redirect fetch (each hop re-validated and
re-resolved; cap 3; https→http downgrades refused) → 2xx only → MIME
allowlist → streamed byte cap (2 MiB default) → deadline (10 s default).

**Commands:** `npx vitest run packages/safe-fetch` → 26/26 pass (SSRF
literals, obfuscated IPv4 forms, DNS rebinding mixed-answer, redirect-to-
private, downgrade refusal, redirect cap, byte cap, timeout, MIME, status);
`npm run check` → PASS all 7 steps (prettier, eslint, typecheck, policy,
skills, tests, evals).

**Risks / open questions:**

- Verify-then-fetch leaves a TOCTOU rebinding window; production wiring
  (CORE-02) must inject a resolver that pins the validated address for the
  actual connection (undici custom lookup).
- Only dotted-quad IPv4 literals are re-checked locally; WHATWG
  canonicalization is trusted to normalize decimal/hex/octal forms (verified
  for 2130706433 and 0x7f000001 in tests on Node 24).
- `missing/no content-type` untested via `new Response` because undici
  defaults one; the empty-content-type branch is covered by the MIME guard's
  base-length check but not directly asserted.

**Next suggested task:** CORE-09 (fake providers) or CORE-01/02 (storage)
— CORE-09 unblocks SRC/ANS work offline without credentials.

## CORE-09 evidence (2026-09-06)

**Files:** `packages/fake-providers/` (new package: `src/fake-providers.ts`,
`src/index.ts`, `test/fake-providers.test.ts`, `package.json`,
`tsconfig.json`); `tsconfig.build.json` (added reference).

**Design:** deterministic, fixture-backed implementations of the existing
`SearchProvider` and `ModelProvider` contract interfaces — no network, no
timers, no randomness. `FakeSearchProvider` serves a fixed hit list
(validated against the `SearchHit` schema at construction), truncates to
`limits.maxHits`, and records queries for assertions. `FakeModelProvider`
does one bounded call per ADR 0006, emits one paragraph per passage citing
exactly that passage's id (grounded default), reports usage via the
contract's conservative token estimator, and supports `citationBehavior:
"hallucinate"` (citations to absent ids — feeds ANS-03's invalid-citation →
evidence-only degradation tests), `failWith` (provider-failure path), and
pre-aborted-signal rejection. Inputs are re-validated with the contract
schemas as defense in depth.

**Commands:** `npx vitest run packages/fake-providers` → 9/9 pass;
`npm run check` → PASS all 7 steps.

**Risks / open questions:**

- `limits.timeoutMs` is deliberately not simulated by the fake (no timers,
  deterministic); deadline enforcement belongs to the caller/harness and is
  covered by safe-fetch's own timeout tests.
- Fakes do not enforce `maxInputTokens`/`maxOutputTokens` ceilings; prompt
  packing enforcement is the model router's job (ANS-01/ANS-02). If those
  tests need ceiling enforcement, extend the fake then.

**Next suggested task:** CORE-01/02 (migrations + storage plugin) or
CORE-05 (budget service) — the offline provider layer is now complete.

## CORE-01 evidence (2026-09-06)

**Files:** `packages/storage/` (new package: `src/migrate.ts`, `src/index.ts`,
`test/migrate.test.ts`, `package.json`, `tsconfig.json`);
`migrations/0001_owners.sql` (first migration); `tsconfig.build.json`
(added reference). New dependency `@libsql/client@^0.18.0` — this implements
ADR 0002's already-accepted driver decision, so no new ADR was needed.

**Design:** forward-only runner, no ORM auto-sync. `applyMigrations(client,
migrations)` creates `schema_migrations (number PK, name, hash, applied_at)`,
then per pending migration: applies SQL + bookkeeping row inside one libSQL
transaction (a failure rolls back both). Applied migrations are sha256
hash-pinned — editing applied SQL is refused. Out-of-order numbers (below the
applied maximum), duplicate numbers, and non-increasing input all fail
closed. `loadMigrations(dir)` reads `NNNN_name.sql` files sorted and rejects
any stray file in the directory. 0001 creates the foundational `owners`
registry table that CORE-03's owner-scoped tables will reference; entity
schemas arrive as their own migrations (expand/contract).

**Commands:** `npx vitest run packages/storage` → 10/10 pass (fresh apply,
idempotent no-op, tamper refusal, rollback semantics, out-of-order, dupes,
loader incl. repo's own `migrations/` chain); `npm run check` → PASS all 7
steps.

**Backup/restore implication (per migrate-storage skill):** migrations run
at startup/connection time in CORE-02. Before applying migrations to the
Turso production DB, take a logical dump (`turso db dump` or sqld snapshot);
rollback story is "restore from backup" — there is no down-migration. 0001
adds one table, size delta negligible. FTS5/vector features remain gated on
the sources.md activation check before the first migration touches them.

**Risks / open questions:**

- Rollback atomicity relies on libSQL `transaction("write")` +
  `executeMultiple` DDL-in-transaction semantics on the local engine; the
  same test must pass against a remote Turso connection at the CORE-02 gate
  (DDL transactional behavior is engine-dependent).
- `applied_at` uses wall-clock time; fine for provenance, not deterministic
  (only affects display).

**Next suggested task:** CORE-02 (storage plugin exposing client +
migrations through a kernel service) or CORE-05 (budget service against the
usage_ledger schema, which will need its own migration).

## CORE-02 evidence (2026-09-06)

**Files:** `packages/plugins/plugin-storage/` (new plugin: `plugin.json`,
`src/index.ts`, `test/storage-plugin.test.ts`, `package.json`);
`packages/kernel/src/kernel.ts` (+`KernelOptions.secretResolver`,
`ctx.secrets.resolve`); `packages/kernel/test/kernel.test.ts` (+secrets
service tests). No sources.md entry needed: no third-party API activated —
Turso connection details are host configuration, and live Turso use remains
gated on the sources.md check recorded there.

**Design:** the plugin owns the process's libSQL client. Local URLs
(`file:*`, `:memory:`) activate with no extra grant (the `fs` capability
covers local DB files). Remote URLs (Turso `libsql://` etc.) fail closed
unless ALL of: the exact DB hostname is in the manifest
`permissions.networkHosts` (kernel-checked via `assertHostAllowed`), an
auth-token secret name is configured AND allowlisted in
`permissions.secrets`, and the kernel has a host-provided
`secretResolver`. Env wiring is host-side (`storageConfigFromEnv` maps
`DO_SIFT_DB_URL` / `DO_SIFT_DB_AUTH_TOKEN_SECRET` /
`DO_SIFT_DB_MIGRATIONS_DIR` → plugin config); the plugin never reads
`process.env`. `activate()` runs the numbered migrations when a migrations
dir is configured; `deactivate()` closes the client.

**Kernel change:** `secrets.resolve(name)` resolves only allowlisted names,
only through a host-injected resolver, and only when the value exists —
each miss throws `CapabilityError`. The host owns the backing store; secret
values never touch manifests or config.

**Commands:** `npx vitest run packages/plugins/plugin-storage packages/kernel`
→ 21/21 pass (round-trip on :memory: + local file with real migrations,
migration skip, three remote fail-closed refusals, one remote success,
env mapping; kernel: allowlisted resolve, non-allowlisted refusal, missing
resolver, unavailable secret); `npm run check` → PASS all 7 steps.

**Security review note:** what the plugin can touch — the single libSQL
database named by host config (read/write, including schema via migrations)
and one allowlisted, kernel-resolved secret. What denies it: kernel
network-host allowlist (remote host not listed → refuse), secrets allowlist

- resolver (missing/wrong name → refuse), plugin-import policy scan (no raw
  `node:fs`/`node:net` in plugin source — libSQL client is the sanctioned
  driver per ADR 0002), INV-003 (no paid/computer capabilities; safe in CI).
  Known limitation: the DB connection target is host config, not per-call
  kernel-mediated; acceptable for a first-party plugin because the storage
  plugin makes no discretionary network calls (see risks).

**Risks / open questions:**

- Remote-path tests activate without executing queries (connection is
  lazy); real Turso connectivity + DDL-transaction parity (CORE-01 risk)
  still needs a live check at the sources.md activation gate.
- Whether remote DB URLs should additionally require an owner-recorded
  grant (like paid/computer) is left open; today the host allowlist + env
  config gate is deemed sufficient for first-party deployment.
- `Client` is exposed raw to the host layer via `client()`; owner-scoped
  repository wrappers (CORE-03) are the intended access boundary, not this
  method.

**Next suggested task:** CORE-03 (owner-scoped repositories over this
client) — CORE-05's budget service then lands on top of the usage_ledger
repository.

## CORE-03 evidence (2026-09-06)

**Files:** `migrations/0002_core_tables.sql` (8 owner-scoped tables:
documents, passages, requests, answers, feedback, episodes, jobs,
usage_ledger — all with owner_id FK to owners, status/enum CHECKs, owner
indexes); `packages/storage/src/repositories.ts` (Repositories class +
row types); `packages/storage/src/index.ts` (exports);
`packages/storage/src/migrate.ts` (bug fix: loader name pattern now allows
underscores — `0002_core_tables.sql` was the first file it would have
rejected); `packages/storage/test/repositories.test.ts`;
`packages/plugins/plugin-storage/test/storage-plugin.test.ts` (chain-length
assertion now derives from loadMigrations); `plans/risks.md` (R-09).

**Design:** every repository method takes `ownerId` and filters on it — no
method accepts an id without its owner, so cross-owner access is
structurally impossible at this layer. Answers store blocks as JSON plus
revisions (prompt/policy/model default `p0`/`p0`/`m0`) matching the cache
key inputs; `findByCacheKey` is owner-scoped (exact-answer cache cannot hit
across owners). usage_ledger rows carry a UTC `day` for daily caps;
`sumTokensForDay` feeds CORE-05. jobs table is schema-only groundwork —
lease/retry semantics are CORE-07.

**Security review (review-security skill, local changes only):**

- Injection: all SQL parameterized via `args`; no value interpolation; no
  dynamic identifiers. Fetcher content is stored via `raw_text` as data.
- Authz (fixtures in repositories.test.ts): cross-owner get/list →
  undefined/empty; cross-owner status UPDATEs are no-ops; cache keys never
  hit across owners; owner-consistent linking enforced on
  passages→documents, answers→requests, feedback→answers (insert refuses
  with "not owned by"). Finding closed during this slice: cross-owner
  linking was originally possible at insert time — now refused and fixture-
  tested.
- Residual: the layer trusts caller-supplied `ownerId` until CORE-04 auth
  exists (recorded as R-09); `usage_ledger.request_id` is not
  ownership-validated at insert (informational column, reservation atomicity
  is CORE-05); "validated citation exists" still is not factual entailment.

**Commands:** `npx vitest run packages/storage` → 23/23 pass (incl. two
cross-owner write fixtures and 0001-data-survives-0002 migration test);
`npm run check` → PASS all 7 steps.

**Backup/restore implication:** 0002 is additive (8 new tables, 5 indexes);
no existing table altered, so rollback = restore pre-0002 backup and nothing
in 0001 data is touched. Fresh local DBs grow negligibly; Turso production
backup via `turso db dump` before first apply remains the rule (CORE-01
evidence).

**Risks / open questions:** see R-09 and the residuals above.

**Next suggested task:** CORE-05 (atomic budget reserve/settle on
usage_ledger) — it needs a transactional update on top of this schema — or
CORE-04 (auth skeleton) to close R-09.

## CORE-05 evidence (2026-09-06)

**Files:** `migrations/0003_usage_ledger_expires_at.sql` (additive
`expires_at` column for reservation deadlines); `packages/storage/src/budget.ts`
(BudgetService); `packages/storage/src/index.ts` (+exports);
`packages/storage/package.json` (+`@do-sift/contracts` dependency for
planReservation/reconcile); `packages/storage/test/budget.test.ts`.

**Design:** `reserve()` runs the contracts' pure `planReservation` (estimate
ceiling check before any ledger write), then in ONE write transaction:
sums held usage (open reservation maxima + settled actuals — never double
counted) against per-owner per-UTC-day caps, and inserts the reservation
row holding the request ceilings with a deadline. `settle()` atomically
writes the settlement row (actual usage) and flips the reservation to
'settled'; overruns are recorded honestly and returned via the contracts'
`reconcile` — settling never blocks on overrun. `expireDue()` flips overdue
open reservations to 'expired' (deadline from 0003), releasing their hold.
Unknown/cross-owner reservations settle as 'unknown-reservation' (no
existence leak); double-settle is refused ('reservation-not-open').

**Commands:** `npx vitest run packages/storage` → 33/33 pass; `npm run check`
→ PASS all 7 steps. Notable fixtures: holds accumulate to the cap then
refuse; caps are per-owner and per-day; a concurrent over-cap race leaves
exactly ONE open reservation (atomicity invariant, checked via ledger
state — the loser may surface as cap-exceeded or a driver-level transaction
lock on the local engine); settle releases the hold so actuals replace
maxima; expired holds release and can't be settled; heldForDay never
double-counts.

**Learnings:** libSQL enforces the `owner_id → owners(id)` FK (test owners
must exist — good, real referential integrity); `reconcile()` takes the
full reservation shape including `expiresAtMs`.

**Risks / open questions:**

- Atomicity relies on libSQL single-writer transactions; the concurrent
  race fixture passes on the local engine. Remote Turso parity check still
  pending (same gate as CORE-01/02: sources.md activation).
- `expireDue` is caller-driven (no background scheduler in CORE-05); the
  answer path (ANS-04) must call it before reserving, or stale holds stick
  until their day rolls over.
- Money boundary: nothing here spends — it gates spending. Paid refusal
  without grant remains INV-003/kernel-side.

**Next suggested task:** CORE-04 (auth skeleton — closes R-09) or CORE-07
(durable job queue on the jobs table).

## CORE-04 evidence (2026-09-06)

**Files:** `packages/auth/` (new package: `src/auth.ts`, `src/loopback.ts`,
`src/index.ts`, `test/auth.test.ts`, `package.json` (dep:
`@do-sift/safe-fetch`), `tsconfig.json`); `tsconfig.build.json` (added
reference).

**Design:** `AuthService.authenticateOwner({token?, clientAddress?})` has
two doors, both fail closed. (1) OIDC: a bearer id-token is verified by the
`OidcVerifier` interface (real provider deferred to the sources.md
credential gate; `StaticOidcVerifier` serves tests/local), and the verified
subject must be on the owner allowlist — compared timing-safe via sha-256
digests. (2) Dev bypass: default-OFF master switch; only a request with NO
token from an IP-literal loopback address acts as the configured dev owner,
who must also be allowlisted. `isLoopbackAddress` is IP-strict (reuses
safe-fetch's IPv4/IPv6 parsers — one classification source): 127/8, ::1,
`::ffff:127.x`, with port/bracket forms; hostnames like "localhost" NEVER
count, so DNS tricks cannot reach the bypass. Refusals are typed
(`invalid-token`, `not-allowlisted`, `authentication-required`,
`dev-bypass-refused`); the returned `ownerId` is what the caller feeds to
the owner-scoped repositories (CORE-03).

**Commands:** `npx vitest run packages/auth` → 12/12 pass (loopback forms
accepted; names/LAN/public/garbage refused; allowlisted OIDC success;
forged token, unallowlisted subject, empty allowlist refused; bypass
success on 127.0.0.1/[::1]:port; bypass refused when disabled, from
non-loopback, without address, without dev owner, or with unallowlisted
dev owner); `npm run check` → PASS all 7 steps.

**Risks / open questions:**

- R-09 narrows but stays open until wiring: the repositories are now
  reachable only through `AuthService` in tests, but no HTTP surface exists
  yet (SRC-05). The risk row is updated, not closed.
- No session/cookie layer and no rate limiting — deliberate for a
  single-owner pre-alpha; revisit at the OPS gate before any public
  deployment (plan 000 non-goal).
- `StaticOidcVerifier` is a test/local fixture only; a real provider needs
  a sources.md entry (terms + price) before activation, per AGENTS.md.

**Next suggested task:** CORE-07 (durable job queue on the jobs table) —
the last CORE task before SRC-01 can assemble the research pipeline.

## CORE-07 evidence (2026-09-06)

**Files:** `packages/storage/src/jobs.ts` (JobQueue);
`packages/storage/src/index.ts` (+exports);
`packages/storage/test/jobs.test.ts`. No migration: the CORE-03 jobs table
already carries status/attempts/lease_until/last_error; retry policy is
queue-level config (`maxAttempts`, `leaseMs`), not per-job columns.

**Design:** FIFO per owner with lease-based durability. `leaseNext(ownerId,
nowMs)` claims the oldest `queued` job OR reclaims a `leased` job whose
lease expired (crash recovery) — claim and bookkeeping in one write
transaction with a guarded conditional UPDATE, so concurrent claimants
cannot both win. Attempts increment at lease time; `fail()` requeues with
the error recorded and the lease cleared until `maxAttempts`, then
dead-letters (`dead` is terminal and invisible to `leaseNext`).
`complete()` refuses unknown/foreign/non-active jobs. Every operation is
owner-scoped and clock-injected (`nowMs`) for deterministic tests; the
queue never executes jobs or grants capabilities — runners claim work
(SRC/BRW).

**Commands:** `npx vitest run packages/storage/test/jobs.test.ts` → 7/7
(FIFO order with lease stamping; empty queue; cross-owner lease/complete/
fail refused; pre-expiry not re-leasable, post-expiry reclaimed with
attempts+1; requeue with lastError; dead-letter at maxAttempts and never
re-leased; complete removes from runnable set); `npm run check` → PASS all
7 steps.

**Learnings:** tests now use a fresh in-memory DB per test (`beforeEach`)
— the queue is FIFO per owner, so a shared DB leaked jobs between tests
and later tests leased leftovers. Queue semantics were correct; the fixture
was wrong.

**Risks / open questions:**

- No background scheduler/worker loop yet: callers drive leaseNext/fail/
  complete. Wiring a runner belongs to SRC-01 (research pipeline) and must
  respect HarnessTask deadlines.
- Visibility/abandoned-job reaping beyond lease expiry (e.g. purging old
  dead jobs) is deferred to OPS retention work.
- Same remote-Turso transaction parity gate as CORE-01/05 (sources.md
  activation).

**Next suggested task:** SRC-01 (plugin-harness-research: search → fetch →
extract → evidence pipeline) — every CORE prerequisite it needs is now
done; remaining CORE-08 (site-access policy plugin) can land in parallel
or just before BRW.

## CORE-08 evidence (2026-09-11)

**Files:** `packages/plugins/plugin-policy-siteaccess/` (new plugin:
`plugin.json`, `src/index.ts`, `test/siteaccess.test.ts`, `package.json`;
deps: contracts, kernel); `packages/contracts/src/sitepolicy.ts`
(BUG FIX: `normalizeHost` now strips ports — both `host:port` and bracketed
v6 — and trailing dots before deny-list matching; the normalizer is
exported for the plugin); `tests/unit/sitepolicy.test.ts` (+bypass
regression cases).

**Design:** the single decision point for every fetch and browser
navigation (ADR 0005). Layered, fail-closed: (1) shipped default-deny list
(INV-007) — absolute, an allowlist entry cannot override it; (2)
robots/ToS registry — per-site decisions (`robotsAccess`
allow/deny/unspecified, `tosAutomated` automated-ok/automated-denied/
unspecified) each requiring a dated `checkedAt`; registry denies win over
everything except layer 1, and a registered-not-denied host counts as
registered; (3) operator denylist; (4) non-empty allowlist is exhaustive;
(5) default allow unless `requireRegistry` (strict mode for the BRW-02
navigation gate: unregistered hosts denied). Invalid registry entries
(missing date, unknown posture values) refuse activation. Zero
capabilities — pure config decisions. Also fixed here: the port/trailing-
dot bypass in `isSiteDenied` flagged in the initial repo analysis
(`linkedin.com:443` / `linkedin.com.` previously matched nothing).

**Commands:** `npx vitest run packages/plugins/plugin-policy-siteaccess
tests/unit/sitepolicy.test.ts` → 13/13 pass (layer precedence incl.
allowlist-cannot-override-default-deny; registry denies with dated
reasons; subdomain matching; strict vs lax default; empty host fails
closed; invalid entries refuse activation; zero-capability proof; kernel
round-trip; port/trailing-dot bypass regressions). Repo-wide: 230/234
tests pass; the only failing file, typecheck errors, and remaining
prettier warning are all in `packages/dev-harness/**` +
`plans/008-dev-signal-harness.md` — another agent's in-progress work
under exclusive ownership (AGENTS.md rule 5), untouched by this task.

**Security note:** what it decides — every host a fetch or navigation may
touch. What denies it: nothing can weaken layer 1 at runtime (shrinking
the shipped deny list requires an ADR per the contracts header); registry
entries are dated so staleness is reviewable; strict mode (`requireRegistry`)
is the default for browser navigation once BRW wires it. The plugin has no
I/O: a hostile config cannot exfiltrate anything — worst case is wrong
decisions, which is why posture values and dates are validated at
activation. Fetch-level SSRF remains safe-fetch's job; this plugin is the
site-policy layer, not a network guard.

**Risks / open questions:** robots.txt is not fetched live — the registry
records human-verified decisions (live robots fetching is BRW-02 scope);
the default-deny list ships with only linkedin.com; extending it is a
policy change per the contracts header; registry staleness has no
automatic expiry (review duty noted in sources.md conventions).

**Next suggested task:** CORE-10 (security negative tests: SSRF variants,
cross-owner, budget bypass — much already exists in per-task suites, this
task consolidates them under tests/security/) or BRW-01 (browser harness
human-paced action layer), for which this plugin is the gate.

## CORE-10 evidence (2026-09-11)

**Files:** `tests/security/ssrf.test.ts`, `tests/security/cross-owner.test.ts`,
`tests/security/budget.test.ts` (new consolidated suites);
`packages/safe-fetch/src/safe-fetch.ts` (+`checkHost` per-hop hook — a REAL
gap this task found and closed); `packages/safe-fetch/test/safe-fetch.test.ts`
(hook coverage).

**Design:** the per-layer suites already proved each guard; CORE-10 adds
the CROSS-LAYER compositions — attacks spanning two modules that no unit
suite covered. SSRF: the layered fetch gate (policy verdict → safeFetch)
with deny-listed sites refused before dialing, private-IP/metadata/
obfuscated-IPv4 literals refused by safe-fetch's layer (documenting the
split: site policy ≠ IP guard), mixed DNS answers failing closed, and
redirects re-checked. Cross-owner: the auth front door (allowlist,
dev-bypass structurally off) composing into the answer service — identical
questions yield isolated answers, the cache never crosses owners, bob's
answer on alice's question is evidence-only with zero borrowed claims, and
raw repository access stays owner-scoped. Budget bypass: repeated answers
with provider-reported usage drain the daily cap until `cap-exceeded`
(model calls stop), the concurrent race leaves exactly one reservation,
expired reservations refuse settlement, cross-owner settle is refused with
no existence leak, and provider-reported overruns land in the ledger
honest and unclipped.

**Finding closed during this task:** safe-fetch handled redirects
internally without re-consulting site policy, so a redirect from an
allowed host to a deny-listed host got DIALED (fixture caught it red
handed). Fix: `SafeFetchOptions.checkHost` — a per-hop hook called for the
initial URL and every redirect target before anything is dialed; the
composition wires `policy.assertAllowed` into it. Covered by a dedicated
safe-fetch test plus the consolidated SSRF suite.

**Commands:** `npx vitest run tests/security packages/safe-fetch` → 41/41
pass; repo-wide `npx vitest run` → 258/258 pass (all packages, including
the dev-harness suites after their owner's fixes); `npx tsc -p
tsconfig.json --noEmit` → 0 errors; `npx prettier --check .` → clean after
formatting this evidence block.

**Security review closure:** plan 002's exit gate — "all security negatives
fail closed; owner isolation proven with a two-owner fixture; zero real
credentials anywhere in the repo or CI" — is met: negatives live in
per-layer suites plus `tests/security/`, the two-owner fixture runs in
cross-owner.test.ts (auth → answer → repos), and the no-secrets scans
(policy.ts INV-005) stay green. Residuals tracked in risks.md: R-04
(runtime escape of third-party plugins — kernel isolation still thin), R-09
(auth wiring is real but the server must remain the sole entry).

**Next suggested task:** BRW-01 (human-paced browser action layer) — every
CORE prerequisite (site-access policy, safe-fetch, budgets, auth, storage)
is now in place; read ADR 0005 first.
