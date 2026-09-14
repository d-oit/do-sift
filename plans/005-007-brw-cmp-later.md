# Plan 005 — BRW browser harness; 006 — CMP computer harness; 007 — later

## 005 BRW — browser harness (proposed)

Playwright-based, human-paced, policy-gated. See ADR 0005 for the hard
boundaries (no stealth, no CAPTCHA bypass, bot-prohibiting sites default-deny).

| ID     | Task                                                                                             | Status        |
| ------ | ------------------------------------------------------------------------------------------------ | ------------- |
| BRW-01 | Human-paced action layer (delays, scrolling, typed input) — pacing for gentleness, never evasion | done          |
| BRW-02 | Site-access enforcement on every navigation: robots + ToS registry + allow/deny lists            | done          |
| BRW-03 | Profile-based sessions (user-supplied logged-in profiles) with no credential keystrokes          | done          |
| BRW-04 | Deny-list enforcement tests (LinkedIn and fixtures) + own-app e2e tests                          | done          |
| BRW-05 | CI guardrail: forbid stealth/anti-detection APIs in code (pattern policy)                        | done (caveat) |

Exit: deny enforcement provable; no stealth code exists; own-site tests green.

## 006 CMP — computer harness (proposed)

Local desktop automation via OS accessibility APIs.

| ID     | Task                                                                          | Status |
| ------ | ----------------------------------------------------------------------------- | ------ |
| CMP-01 | Action-class consent UI (interactive approval per class; disabled by default) | done   |
| CMP-02 | Replayable action log; no remote control surface                              | done   |
| CMP-03 | Consent-bypass fail-closed tests; secret injection via OS keychain only       | done   |

Exit: replay test passes; bypass test fails closed.

## 007 RET / LRN / OPS / QUAL (proposed)

- RET: local ONNX embeddings + libSQL vector index **only after** beating the
  FTS5 baseline on the held-out set (gate recorded in evals/baselines).
- LRN: episodes, shadow policies, promotion/rollback with held-out eval gates.
- OPS: container, deploy docs, backup/restore rehearsal, release candidate.
- QUAL: held-out manual evaluation, abuse/isolation/accessibility, retention.

### OPS task table

| ID     | Task                                                                                                        | Status |
| ------ | ----------------------------------------------------------------------------------------------------------- | ------ |
| OPS-01 | Backup/restore rehearsal: local libSQL snapshot + verify (Turso procedure documented, not executed)         | done   |
| OPS-02 | Deployment documentation: env config, local file vs Turso, reverse proxy, backup cadence                    | done   |
| OPS-03 | Container image: Dockerfile, non-root, healthcheck, offline checks inside                                   | done   |
| OPS-04 | Release candidate 0.1.0 via prepare-release skill (validate only; never publish)                            | done   |
| OPS-05 | Packaged server entrypoint under `apps/` (env-configured composition; turns the image into a service image) | done   |

### OPS-05 decomposition (2026-09-14, htn-planner workflow per plan 009)

Preconditions met: the composition seam exists (`createRuntime`, RET-04),
the HTTP surface exists (`createResearchServer`, ANS-05/SRC-05), provider
and fetch APIs are read (auth, safe-fetch, site-access policy, fixtures),
and the Dockerfile header already prescribes this task ("when it lands, the
CMD switches to it"). No third-party uncertainty remains → vertical slice,
no spike. Ordered subtasks, each gated on `verify --set feedback` exit 0:

1. Plan row + decomposition recorded (this section).
2. Red tests: `apps/server/test/main.test.ts` — `parseEnvConfig` matrix
   (defaults; owner allowlist required non-empty; dev-bypass gating; remote
   DB URL refused with a pointer to the storage-plugin path; unknown
   provider values refused) + `composeApp` smoke over real HTTP with
   fixture providers on `:memory:` (`/healthz` 200 unauthenticated;
   `/api/research` SSE completes; `/api/answer` 501 when no model is
   configured, grounded answer when the fixture model is configured) +
   fail-closed composition errors. Plus `packages/server` tests for the
   `/healthz` route and configurable `listen` port.
3. Implement `packages/server` deltas: `/healthz` (static ok, no data) and
   `listen(server, host, port = 0)` (backward-compatible default).
4. Implement `apps/server/src/{config,main,index}.ts`: env → config →
   composition (storage client + migrations + owners seed, AuthService +
   StaticOidcVerifier, optional fastembed embedder, fixture providers only
   when explicitly configured) → `createRuntime` → `createResearchServer`
   → listen; SIGTERM/SIGINT graceful close; honest startup log. `main()`
   stays thin; all logic testable through `composeApp`.
   **Amendment before implementation:** in fixture mode `fetchPage` is a
   synthetic page store (`.test` hosts, nothing leaves the process) —
   safeFetch + site-access policy enter with the first live search
   adapter, not before it; the runtime's `model` option becomes optional
   (search mode = zero LLM calls is a recorded product invariant, so a
   research-only runtime must compose).
5. `vitest.config.ts` gains `apps/**/test/**/*.test.ts`; Dockerfile CMD →
   the entrypoint, HEALTHCHECK → `/healthz` probe (port from env);
   build-time offline eval stays. CHANGELOG gains the entrypoint under
   [0.1.0] Added.
6. Docs: `docs/deployment.md` replaces the "pending" note with the
   entrypoint usage (env table, run examples, limits).
7. Verify (feedback in the loop, verification set at handoff); record
   evidence; commit.

Acceptance: entrypoint starts offline with fixture providers and serves
research + (with fixture model) grounded answers; refuses to start without
an explicit search provider or owner allowlist; never starts networked
providers silently (none exist yet — SRC-02/ANS-02 live gates untouched);
image builds and its healthcheck probes the real service.

### BRW-01 evidence (2026-09-11)

**Files:** `packages/plugins/plugin-harness-browser/` (new plugin:
`plugin.json`, `src/index.ts`, `test/browser-harness.test.ts`,
`package.json`; deps: contracts, kernel).

**Design:** the human-paced action layer as a `harness` plugin declaring
exactly the `browser` capability (ADR 0005 scope). Executes a bounded
`BrowserActionPlan` (navigate/scroll/type/click) against an injected
`BrowserDriver` — the seam Playwright implements in BRW-04; the dependency
is deliberately deferred so this slice stays offline and deterministic
(INV-006; also avoids an unplanned heavy dependency without a decision
record). Pacing: FIXED, configured delays (actionDelayMs between actions,
typeDelayMs per keystroke, scrollPauseMs after scroll steps) — "pacing for
gentleness, never evasion": constants for rate limiting, deliberately NOT
randomized or fingerprint-shaped. Boundaries: every navigate passes the
injected site-access gate BEFORE the driver (denials logged with
`deniedBy: "site-access"`); `maxActions` truncates the plan; `deadlineMs`
stops the run with outcome `timeout`; every action lands in a
contract-validated replayable `HarnessRunLog`. Injected `now`/`sleep` make
pacing and deadlines fully deterministic in tests.

**Commands:** `npx vitest run packages/plugins/plugin-harness-browser` →
8/8 pass (ordered execution with the exact pacing sequence [750, 750, 750,
400, 750, 400]; type-rate recorded per keystroke; policy-denied navigate
never touches the driver and logs denied; maxActions truncation; deadline
timeout mid-plan; deactivate closes the driver; run-before-activate
refused; contract validation; zero... browser capability assertion; kernel
round-trip). `npm run check` → PASS all 7 steps.

**Security note (add-plugin acceptance):** what it can touch — an injected
driver's page actions within a bounded plan; no network of its own, no
secrets, no credentials ever typed (BRW-03 keeps it that way). What denies
it: the site-access policy gate on every navigate (CORE-08's layered
decisions, default-deny list first), task limits (maxActions/deadline),
INV-004 (policy.ts rejects stealth/CAPTCHA patterns in this very file —
the description itself was written to stay clean), and the kernel grant
rules once `browser` joins GRANT_REQUIRED if the owner decides so.

**Risks / open questions:** no action PLANNER yet — callers supply the
plan (planner-free by design for BRW-01); whether `browser` should join
GRANT_REQUIRED (like paid/computer) is an open owner decision (AGENTS.md
lists browser grants as approval-gated but the kernel doesn't enforce it
yet); Playwright wiring (real browsers, CI weight) lands with BRW-04.

**Next suggested task:** BRW-02 (site-access enforcement on every
navigation — wire this harness's gate to the CORE-08 policy plugin's
registry and strict mode) or BRW-05 (CI guardrail is already covered by
policy.ts's noStealthPatterns; verify and mark done).

### BRW-02 evidence (2026-09-11)

**Files:** `packages/plugins/plugin-harness-browser/` — `src/index.ts`
(SiteAccessGate doc contract: the CORE-08 policy plugin is the canonical
gate; browsers MUST wire `requireRegistry` strict mode; the harness never
navigates without consulting it), `test/site-enforcement.test.ts` (new:
end-to-end layered enforcement), `package.json` (+policy plugin dep).

**Design:** BRW-01's gate was a stub interface; BRW-02 proves the real
composition — the harness wired to the actual CORE-08 policy plugin
(satisfied structurally, no adapter code needed). End-to-end through full
harness runs: registered+approved hosts navigate; robots-denied hosts are
refused (layer 2, dated reason in the log); ToS-denied hosts are refused
even with robots allow; linkedin.com is refused at layer 1 (shipped
default-deny) — including via subdomain, port, and trailing-dot variants,
and even when a registry entry tries to allowlist it; unregistered hosts
are refused in `requireRegistry` strict mode; a denied navigation stops
the plan (subsequent actions never run).

**Commands:** `npx vitest run packages/plugins/plugin-harness-browser` →
11/11 pass (8 BRW-01 + 3 BRW-02). `npm run check` → PASS all 7 steps.

**Security note:** the gate is fail-closed and layered with layer 1
unoverridable at runtime; denial reasons are recorded per action in the
replayable run log; strict mode makes the registry (dated decisions) the
only path to navigation. Residual: live robots.txt fetching is NOT here —
the registry holds human-verified decisions (BRW-02 scope per plan row);
automating robots fetches would need its own terms review.

**Next (BRW row notes):** BRW-05's mechanism already exists —
`scripts/policy.ts (check noStealthPatterns)` = INV-004, rehearsed in
FND-09 with a planted violation, enforced in CI via `npm run check` /
`check:fast` in ci.yml. Marked done with a caveat: the pattern list is
narrower than "all anti-detection APIs" (stealth, webdriver/fingerprint
spoofing, captcha services, navigator.webdriver override); extending it
edits scripts/policy.ts, which is AGENTS.md approval-gated — noted as the
follow-up needing an owner decision.

### BRW-03 evidence (2026-09-11)

**Files:** `packages/plugins/plugin-harness-browser/` — `src/index.ts`
(CredentialGuard patterns + `isCredentialSelector`; type-action refusal in
the run loop with `deniedBy: "credential-guard"`; profile-session contract
on the BrowserDriver doc: the user-supplied profile directory is a
DRIVER-FACTORY concern — e.g. Playwright launchPersistentContext in BRW-04
— and the guarantees here hold for any profile), `test/credential-guard.test.ts`
(new).

**Design:** the enforceable core of "no credential keystrokes": automation
never types into credential-shaped fields. The guard pattern list is
deliberately broad (password/passwd/pwd/passwort, otp/totp/2fa/mfa,
one-time/verification code, cvv/cvc/security-code, card/cc-number, ssn,
api-key, secret/private-key, auth-token) — a false positive costs one
denied action; a false negative would type a secret. There is NO
configuration to disable it, and the refusal stops the plan (outcome
"denied"). Log hygiene is structural: type details record the selector and
typed LENGTH only — a fixture serializes the whole run log and asserts the
typed text never appears. Profile sessions themselves arrive via the
user's own logged-in browser profile; this harness adds the guarantees
that make that safe to point at do-sift.

**Commands:** `npx vitest run packages/plugins/plugin-harness-browser` →
15/15 pass (14 credential-shaped selectors refused with zero driver
reaches; plan stops at the guard; logs stay secret-free; broad-but-safe
classification incl. `bypass-link` NOT matching after the leading-\b fix
and bare `#totp` matching after the acronym fix). `npm run check` → PASS
all 7 steps.

**Security note:** what denies credential typing here: the guard is
structural (no config escape), INV-004 scans this file for stealth
patterns, and the replayable log proves what was (not) typed. Residual:
the guard is selector-heuristic based — a site could name a password
field something innocent; the durable defense remains that profiles are
user-supplied sessions (login happened BEFORE automation) and BRW-04's
real driver should additionally refuse typing into
`input[type=password]` at the DOM layer where the actual element type is
known — noted for BRW-04.

**Risks / open questions:** classification is English/heuristic based;
click-on-login-button is deliberately allowed (profiles are already
logged in; a click is not a keystroke). No fixes needed to the contract
interface — profileDir intentionally absent from harness config to keep
the fs boundary in the driver factory.

**Next suggested task:** BRW-04 — the real Playwright driver (first
dependency addition, needs the sources.md-style decision note), own-app
e2e, and the DOM-level `input[type=password]` typing refusal noted above.

### BRW-04 evidence (2026-09-13)

**Files:** `packages/browser-driver/` (new host package: `src/index.ts` —
PlaywrightDriver implementing the harness's BrowserDriver seam, DOM-level
credential refusal, launchPersistentContext profile support; `test/playwright-driver.test.ts`;
`package.json`; `tsconfig.json`); `plans/risks.md` (R-10).

**Dependency decision:** `playwright@1.63.0` added to
`packages/browser-driver` only — this implements plan 005's already-recorded
"Playwright-based" decision (not an improvisation). Chromium binaries are a
LOCAL install (`npx playwright install chromium`); CI remains untouched
(workflow edits are approval-gated): without a browser the e2e suite skips
at the launch boundary — a skip confined to browser availability, with
every unit/offline check still enforced.

**Design:** PlaywrightDriver — chromium, headless, default user agent, no
fingerprint shaping (INV-004). BRW-03's durable defense implemented:
before typing, the driver inspects the REAL element — `input[type=password]`,
credential `autocomplete` hints (current-password/new-password/
one-time-code/cc-*), or credential-shaped name/id/aria-label — and throws
`CredentialTypingError`; typing uses `pressSequentially` for true
per-keystroke pacing. Profile sessions: `profileDir` →
`launchPersistentContext` (the user logged in themselves; automation never
does).

**Commands:** `npx vitest run packages/browser-driver` → 3/3 pass on a real
chromium: (1) own-app e2e — navigate → type with pacing → submit on a
loopback page, typed query proven in the resulting URL; (2) deny-list
enforcement — linkedin.com (layer 1), robots-denied.test (layer 2),
unregistered.test (strict layer 5) all refused BEFORE the browser loads
them; the page never leaves the own app; (3) DOM-level credential refusal —
"#field-a" (innocent selector, real `input[type=password]`) and "#cc"
(`autocomplete="cc-number"`) both refused at the DOM layer the selector
guard cannot see. `npm run check` → PASS all 7 steps. Dev-signal
verification set: green, receipt `.do-harness/evidence.verification.json`
(2026-09-13T12:58Z), halted: none.

**Security review (review-security skill):** page DOM is input treated as
data — attributes read via evaluate, no page strings executed or rendered;
selectors/typed text come only from trusted action plans; no workflow
changes; no secrets in logs (BRW-03 fixtures). Finding (low, accepted):
the driver run OUTSIDE the harness would bypass site policy — recorded as
R-10; the harness (policy gate + pacing + bounds) is the only documented
execution path. Residual: CI cannot run this e2e until an owner approves a
workflow change to install browsers; until then the e2e proof is local-run
only, with offline suites enforcing all logic checks.

**Risks / open questions:** R-10 (driver-without-harness); headless
detection/compatibility differences on hostile sites are out of scope by
ADR 0005 (no anti-detection); CI browser install is the open owner
decision.

**BRW milestone: COMPLETE (BRW-01..05). Next suggested task:** CMP-01
(computer-harness consent UI) or OPS-adjacent work (container/deploy docs)
per plan 007.

### CMP-01 evidence (2026-09-13)

**Files:** `packages/plugins/plugin-harness-computer/` (new plugin:
`plugin.json`, `src/index.ts`, `test/computer-harness.test.ts`,
`package.json`; deps: contracts, kernel).

**Design:** the consent layer for local desktop automation (ADR 0005:
local-only, consent-gated, default-off). Two independent switches must
both hold: `config.enabled === true` (default-off activation refusal) AND
the kernel's computer grant (INV-003, GRANT_REQUIRED — refused outright in
ci). Per-class interactive consent: every action (open/type/click/scroll/
key) consults a `ConsentLedger` of remembered per-class verdicts; the
first action in a class prompts the injected `ConsentPrompt` (a real
readline CLI lands with the real driver; tests use scripted approvers);
`rememberClass` decisions apply for the rest of the run; a remembered deny
never prompts again. FAIL-CLOSED: no prompt wired → unconsented classes
deny. Every action and every consent decision is recorded (replayable run
log + append-only ledger — CMP-02 consumes both). Decisions take the
injected clock (deterministic tests).

**Commands:** `npx vitest run packages/plugins/plugin-harness-computer` →
7/7 pass (default-off refusal incl. truthy-string enabled; kernel
CapabilityError without grant + ci outright refusal with grant; one ask
per class with remembered allows; remembered deny never re-prompts;
non-remembered verdict re-asks; fail-closed with no prompt; run-before-
activate refused). `npm run check` → PASS all 7 steps. Dev-signal
verification set: green, receipt `.do-harness/evidence.verification.json`.

**Security note:** what it can touch — the injected DesktopDriver within
consented, bounded plans; no network, no fs, no secrets. What denies it:
config default-off, the kernel computer grant (both required), per-class
consent (fail-closed without an approver), task limits, and INV-004's
stealth scan over this file. The consent UI itself (interactive) is the
user's local terminal — no remote surface exists (CMP-02 formalizes).

**Risks / open questions:** the real OS accessibility driver is not built
yet (tests inject a fake) — wiring it needs a platform decision
(accessibility APIs per OS); consent persistence across runs is
deliberately per-run (rememberClass does not outlive the harness instance)
until CMP-03 decides on durable grants; keychain secret injection is
CMP-03 scope.

**Next suggested task:** CMP-02 (replayable action log formalization +
explicit no-remote-control guarantee) or CMP-03 (consent-bypass fail-closed
tests + OS keychain secret injection).

### CMP-02 evidence (2026-09-13)

**Files:** `packages/plugins/plugin-harness-computer/` — `src/replay.ts`
(new: tamper-checked, consent-authoritative replay), `src/index.ts`
(no-remote-control contract in the module doc + replay re-exports),
`test/replay.test.ts` (new).

**Design:** the recorded log is the CONSENT AUTHORITY for replay:
`replayComputerRun({log, plan, driver})` re-executes exactly the
recorded-allowed actions in order against the injected driver, SKIPS
recorded-denied actions (never re-attempted), and never prompts — replay
takes no ConsentPrompt parameter at all (structural proof in tests). The
plan is matched against the log entry-by-entry (same count, same action
kinds in the same order); any mismatch — extra, missing, or reordered
actions — is refused as `ReplayError` tampering, so a plan cannot smuggle
in actions the recorded run never performed or never asked for.
Pacing-dependent type details are not identity (a log recorded at
60ms/keystroke replays against a 200ms/keystroke detail). NO REMOTE
CONTROL SURFACE: the module binds no sockets and exposes no network API —
guarded by an export-surface test (only local names: ConsentLedger,
createComputerHarness, ReplayError, replayComputerRun, types; nothing
resembling listen/serve/bind/connect/createServer/expose). Audit replays
run at full speed (no per-keystroke delay).

**Commands:** `npx vitest run packages/plugins/plugin-harness-computer` →
12/12 pass (replay executes 2 allowed + skips 1 denied with the key
combo never re-attempted; no-prompt structural proof; tamper refusals for
extra/missing/reordered plans; pacing-detail tolerance; export-surface
guard). `npm run check` → PASS all 7 steps. Dev-signal verification set:
green, receipt `.do-harness/evidence.verification.json`.

**Security note:** replay cannot escalate consent — the log's allowed set
is the ceiling, denied actions are structurally skipped, and tampered
plans are refused before any execution. The export-surface guard is a
regression tripwire: any future PR adding a network surface to this
plugin fails the test.

**Risks / open questions:** replay is 1:1 with the original plan/log
pair; partial replays (suffix of a run) are deliberately unsupported
until a use case exists; the consent ledger is not yet persisted across
processes (CMP-03 decides durable grants + keychain secrets).

**Next suggested task:** CMP-03 (consent-bypass fail-closed tests + OS
keychain secret injection) — the last CMP task.

### CMP-03 evidence (2026-09-13)

**Files:** `packages/plugins/plugin-harness-computer/` — `src/index.ts`
(prompt-crash denial, garbage-verdict handling that preserves CMP-01's
remembered-deny semantics, defensive-copy ledger, secret-shaped config
refusal, `KeychainProvider` contract), `test/computer-harness.test.ts`
(unchanged semantics), `tests/security/consent.test.ts` (new consolidated
bypass suite), `plans/risks.md` (no change).

**Design:** consent-bypass hardening, fail closed at every seam:
(1) a CRASHING consent prompt is a denial — recorded, log intact, driver
untouched; (2) garbage verdicts (non-boolean allowed/rememberClass) deny
without memory, while a WELL-FORMED deny keeps its rememberedClass
(CMP-01 semantics preserved — the first fix broke this and the CMP-01
suite caught it); (3) `ConsentLedger.all()` returns a defensive copy —
external callers cannot rewrite the consent record; (4) activation
refuses secret-shaped config keys (password/token/api-key/credential/
private-key) — secrets ride in the OS keychain ONLY, via the exported
`KeychainProvider` contract the real driver will consume; (5) the enabled
flag accepts only the exact boolean `true`. Consolidated bypass suite in
tests/security composes kernel + harness: every attempt (flag substitutes,
secret config, missing grant, ci-with-grant, crash, garbage, no prompt,
ledger rewrite) fails closed.

**Commands:** `npx vitest run tests/security/consent.test.ts
packages/plugins/plugin-harness-computer` → 18/18 pass. `npm run check` →
PASS all 7 steps. Dev-signal verification set: first run went RED (it
correctly caught an unformatted plan file from the status edit — the
receipt system working as designed); after fixing the cause the set is
GREEN with receipt `.do-harness/evidence.verification.json`, no strikes
recorded (never cleared; the fix landed first).

**Security note:** the bypass surface is now: enabled flag (strict boolean),
kernel grant (INV-003, ci-refused), per-class consent (crash/garbage/
absence all deny), ledger (copy-only), config (secret-free by refusal),
replay (no prompts, tamper-refusing — CMP-02). Secrets: keychain-only is
enforced negatively here (config refusal) and structurally for logs
(length-only details); the positive path (real driver resolving
`KeychainProvider`) lands with the real OS accessibility driver.

**Risks / open questions:** keychain backends are platform-specific —
choosing one (Windows Credential Manager vs DPAPI vs cross-platform lib)
is a decision for the real-driver task; consent persistence across
processes remains per-run by design.

**CMP MILESTONE: COMPLETE (CMP-01..03). Exit gates met: replay test
passes (CMP-02); bypass tests fail closed (CMP-03).**

### OPS-01 evidence (2026-09-13)

**Files:** `packages/storage/src/backup.ts` (new: `backupToFile` via
`VACUUM INTO`, `openRestore`, `verifyRestore`,
`assertLocalLibsqlUrl`); `packages/storage/src/index.ts` (+exports);
`packages/storage/test/backup.test.ts` (new).

**Design:** backup = a consistent SQLite snapshot via `VACUUM INTO` (one
statement; the destination must not exist — the engine's own
never-overwrite refusal is the backup safety). Restore = opening the
snapshot (`openRestore`); `verifyRestore` compares the table set,
per-table row counts, and the full owners registry. Remote Turso URLs are
refused with the documented remote procedure (`turso db dump` /
platform snapshots) — `VACUUM INTO <path>` is server-side and meaningless
remotely. The rehearsal test is the real thing: seed a file DB, snapshot,
simulate total loss of the original, then prove the snapshot alone
contains all owners/documents/passages AND a working FTS index.

**Commands:** `npx vitest run packages/storage/test/backup.test.ts` → 5/5
pass (snapshot verifies against live DB; post-backup mutations do NOT
leak into the snapshot and verification catches the divergence; overwrite
refused; remote URL refused with Turso guidance; total-loss rehearsal
survives with FTS working). `npm run check` → PASS all 7 steps.
Dev-signal verification set: green (one RED intermediate caught an
unformatted plan — cause fixed first, then green; receipt
`.do-harness/evidence.verification.json`).

**Backup/restore implication (migrate-storage skill):** what to back up —
the whole DB file (all milestones' tables; one file). When — before any
destructive change and on a cadence (OPS-02 documents the cadence); the
snapshot is a single portable file. What breaks on rollback — nothing:
restore IS opening a snapshot; the rollback story for any future
migration remains "restore from backup" (CORE-01 evidence). Size delta —
snapshot ≈ original (VACUUM-compact). Turso production: procedure
documented, NOT executed (needs the live DB; sources.md gate).

**Risks / open questions:** `VACUUM INTO` blocks writers briefly on the
local engine (single-user pre-alpha: fine); Windows may hold the original
file handle briefly past close (EPERM on deletion — the rehearsal treats
the original as abandoned; logical-loss semantics are identical);
FTS-index snapshots verified working (porter/unicode61 tokenizer carried
in the snapshot).

**Next suggested task:** OPS-02 (deployment documentation) or OPS-03
(container image) — OPS-04 (release candidate) last.

**Row-status correction (2026-09-13, follow-up agent):** the task row above
was still `proposed` while the evidence below was already complete
(recorded by the OPS-01 owner alongside OPS-02). Verified before flipping:
the backup/restore suite has run green in every full-check this session
(`packages/storage/test/backup.test.ts` 5/5, most recently in today's
verification-set receipt). Row flipped to `done` on the strength of the
recorded evidence; no content of the evidence was altered.

### OPS-02 evidence (2026-09-13)

**Files:** `docs/deployment.md` (new), `README.md` (deployment section +
status update).

**Design:** deployment documentation accurate to the code as it exists:
env config table (`DO_SIFT_DB_URL` / `DO_SIFT_DB_AUTH_TOKEN_SECRET` /
`DO_SIFT_DB_MIGRATIONS_DIR` via `storageConfigFromEnv`); the fail-closed
remote rules (networkHosts allowlist + kernel-resolved token secret +
sources.md gate); auth configuration (allowlist, OIDC stub caveat, dev
bypass loopback-only with strict-boolean default-off); network exposure
(no TLS, no rate limiting in the server → loopback-only or a TLS-
terminating, rate-limiting reverse proxy; nosniff must survive); backups
(cadence: before deploys/migrations + daily; `VACUUM INTO` local,
`turso db dump` remote — documented, not executed); verification via
`npm run check` + dev-signal receipts. Known-limits section states the
honest gaps: single owner, no container yet (OPS-03), no app entry under
`apps/`, remote Turso parity untested until the sources.md gate.

**Commands:** `npm run check` → PASS all 7 steps. Dev-signal verification
set: green, receipt `.do-harness/evidence.verification.json`.

**Risks / open questions:** docs drift is the standing risk — the
known-limits section is the contract to revisit at each OPS/QUAL step;
the packaged app entry (apps/) remains pending and is called out in the
doc rather than papered over.

**Next suggested task:** OPS-03 (container image: Dockerfile, non-root,
healthcheck) — note Dockerfile authoring is code, not a workflow change,
so no approval boundary is crossed; running/publishing it would be.

### OPS-03 evidence (2026-09-13, follow-up agent)

**Files:** `Dockerfile` (new), `.dockerignore` (new).

**Design:** the image carries the runtime and runs the **offline checks
inside** — the task's literal ask — because no packaged server entrypoint
exists yet (OPS-02's doc records the `apps/` entry as pending; inventing
one here would have been unmeasured scope). `node:22-slim` (Debian glibc,
not alpine: `@libsql` and `onnxruntime-node` ship glibc prebuilds);
`npm ci --include=dev` (the repo runs through tsx, a devDep — an initial
`ENV NODE_ENV=production` pruned it and the build failed `tsx: not found`,
fixed by dropping the env and making the include explicit); build-time
`RUN npm run eval:offline` proves the deterministic suite in-container and
warms `.fastembed_cache` into the layer so runtime checks stay offline;
non-root via the image's `node` user; `HEALTHCHECK` + `CMD` both run the
offline suite (honest liveness for a check image — when the packaged
server entrypoint lands, they switch to the service probe).

**Commands (with the environment story, recorded honestly):** two build
attempts crashed the daemon mid-`npm ci` (EOF, engine pipe gone) — cause
found: Docker Desktop was self-updating under the builds (29.4.0 →
29.7.2); the third build on the stabilized daemon went green. Runtime
verification: `docker run --rm do-sift:0.1.0-rc id -un` → `node`
(non-root ✓); fresh `docker run --rm do-sift:0.1.0-rc` → `eval: PASS (31
deterministic cases, 0 network calls, 0 model calls)` ✓; healthcheck
present (CMD = eval runner, 120s interval); image size 1.18 GB.

**Risks / open questions:** 1.18 GB image — it carries the dev toolchain
plus ONNX runtime and model; a slimmed runtime image belongs to the
packaged-entrypoint work; the model cache is baked at build, so a model
bump means a rebuild; fastembed's dependency tree emits deprecation
warnings (`boolean@3.2.0`, `tar@6.2.1`, `@anush008/tokenizers` archived) —
recorded as a supply-chain signal against ADR 0009, not blocking.
Publishing the image was NOT done (approval boundary).

**Next suggested task:** OPS-04 (release candidate 0.1.0 via the
prepare-release skill — validate only, never publish), now that OPS-01
through OPS-03 are done.

### OPS-04 evidence (2026-09-13, follow-up agent) — blocked on commit

**Status: blocked — the candidate has no immutable SHA to build against.**
`npm run release:check` → PASS for candidate v0.1.0 on branch main, and it
validated (working-tree): package.json version 0.1.0 well-formed;
CHANGELOG.md contains `## [0.1.0]`; migrations monotonic (0001–0005, now
including the RET-02 embeddings migration); tag `v0.1.0` does not exist
yet. But the check stamps the candidate with HEAD — and HEAD (3acb20e) is
the repo's initial commit, while the working tree carries the entire
uncommitted session (~65 entries: plans 008–011, the dev-harness CLI,
hybrid retrieval, OPS work). Building artifacts from the dirty tree and
stamping them `3acb20e` would be a false receipt (skill rule: never bypass
a missing check — here, the missing state is a commit).

**What is already true and will carry over once committed:**
`npm run check` PASS 7/7 on this tree today; the offline verification
image `do-sift:0.1.0-rc` exists but was built pre-commit — the release
image must be rebuilt at the committed SHA for the immutable digest and
the rollback note (previous digest: none — first release).

**Unblock (owner decision, one step):** commit the working tree to main.
Then the prepare-release skill finishes mechanically at that SHA:
release:check re-run (SHA now truthful) → artifacts (image rebuild,
source archive, checksums, SBOM) → `npm run check` on the exact SHA →
`docs/release.md` checklist (version, SHA, digests, migration notes:
0001–0005 forward-only, none destructive; rollback: no previous release)
→ **stop** before any publishing (separate approval-gated step).

**Publishing was NOT performed and the tag was NOT created** (approval
boundary; the check itself confirms the tag is still free).

### OPS-04 evidence (2026-09-14, follow-up agent) — candidate assembled and validated, not published

**Unblock performed:** the session was committed to main — HEAD is now
`485ed75d99338cb8cea830f24b6758754807d820` ("Session 2026-09-13/14:
plans 008-011 + OPS 01-03"), tree clean. The same commit carries the
plan-010 DSH-07/DSH-08 row corrections (correction note recorded there).
Before committing, the full verification set was re-run on the tree
(`npm run signals -- verify --set verification` → 7/7 green; pre-commit
feedback set passed inside the hook).

**prepare-release skill, step by step:**

1. `npm run release:check` → `PASS — candidate v0.1.0 @ 485ed75d9933
(branch main)`. The SHA stamp is now truthful.
2. Artifacts assembled without publishing credentials, in
   `dist/release/v0.1.0/` (gitignored): container image `do-sift:v0.1.0`
   = `sha256:4f709352009e7ed767e4760ac0fb59fa01e8e3a6215666ac7bdfc5b4b4d149b7`
   (image ID; registry digest materializes at push), built at the
   committed SHA with `npm run eval:offline` executing **inside** the
   image at build time (passed — the deterministic suite is the image
   payload, INV-006); source archive `do-sift-v0.1.0-src.tar.gz`
   (`git archive HEAD`); CycloneDX 1.5 SBOM (`npm sbom`,
   `sbom-cdx-0.1.0.json`); `sha256sums.txt` over archive + SBOM.
   Provenance attestations are produced at the publish push, not locally —
   recorded as such. The pre-commit-era image `do-sift:0.1.0-rc`
   (`2608fa09c9f7`) is superseded and marked as such in `docs/release.md`.
3. `npm run check` on the exact SHA → PASS all 7 steps.
4. `docs/release.md` written: candidate identity (version, SHA,
   digests), artifact table, migration notes (0001–0005 forward-only,
   all additive), rollback (first release: no previous image digest;
   restore-from-backup path via the OPS-01 procedure — no downgrade
   scripts exist), open risks (R-06 citation-confidence limits, R-08
   no independent security review, packaging caveat: image CMD still
   runs the offline suite pending the `apps/` server entrypoint).
5. **Stopped before publishing.** No tag created (`git tag -l` empty),
   no GHCR push, no package publish, no deployment — all remain the
   separate approval-gated step.

**Files:** `docs/release.md` (new), this plan (row flip + this entry).
`dist/release/v0.1.0/` artifacts are gitignored by design.

**Risks / open questions:** the candidate is a verification image, not a
deployable service image (server entrypoint pending under `apps/` —
documented in the Dockerfile header and `docs/release.md`); SBOM is
lockfile-level (npm), not image-filesystem-level (syft unavailable —
noted, not blocking); publishing decision sits with the owner.

**Next suggested task:** the publish gate (tag v0.1.0 + GHCR push) is the
owner's approval-gated call; development-wise nothing remains open in
plans 001–011 — the next feature work is the live-provider activation
gates (SRC-02/ANS-02 live adapters), which are also ask-first.

### OPS-05 evidence (2026-09-14, agent)

**Files:** `apps/server/src/config.ts` (new: pure `parseEnvConfig` —
fail-closed env matrix, every refusal names the offending variable),
`apps/server/src/main.ts` (new: `composeApp` — local libSQL client +
migrations + owners seed, AuthService + StaticOidcVerifier (empty token
map: bearer tokens refuse until a real OIDC verifier passes its sources.md
gate), fixture search + fixture page store as `fetchPage` (`.test` hosts —
nothing leaves the process), optional fastembed embedder, optional fixture
model, `createRuntime` → `createResearchServer` → `listen`;
`main()` — honest startup log, SIGINT/SIGTERM graceful close),
`apps/server/src/index.ts` (new: thin boot), `apps/server/test/main.test.ts`
(new, 13 tests), `packages/server/src/server.ts` (`/healthz` route —
unauthenticated, constant body; `listen` gains a port parameter, default
0 for compatibility), `packages/server/src/runtime.ts` (`model` option
now optional — search mode is zero-LLM by recorded product invariant;
answer/answerResponse refuse with a clear error when absent),
`packages/server/test/server.test.ts` (+1 healthz),
`packages/server/test/runtime.test.ts` (+1 model-less runtime),
`vitest.config.ts` (+apps include), `Dockerfile` (CMD → the entrypoint;
HEALTHCHECK → `/healthz` probe; writable `/data` volume as the in-image
DB default — the old CMD only read, the service must write; baked model
cache chowned; `ENV DO_SIFT_HOST=0.0.0.0` per container convention;
fail-closed env still not defaulted), `CHANGELOG.md` (+entrypoint under
[0.1.0] Added), `docs/deployment.md` (entrypoint usage: env table, run +
docker run examples, limits).

**Decomposition amendment (recorded before implementation, see the
decomposition section):** fixture mode's `fetchPage` is the synthetic
page store; safe-fetch + site-access policy enter with the first live
search adapter.

**Process notes:** red-first (the new tests failed or could not compile
before implementation). One real catch by the sensors, not by me: the
`pluginImports` policy flagged `apps/server/src/main.ts` importing
`node:http` — apps/ is deliberately scanned like plugin territory, so the
server type now derives from `createResearchServer`'s return type instead
of a raw import (policy not weakened). One Windows-only test artifact:
back-to-back apps binding the same fixed port reset connections
(SO_REUSEADDR double-bind) — fixed with a `port` test seam (ephemeral 0),
not by loosening the tests. One mangled-edit incident on
`runtime.test.ts` (a new test accidentally replaced an existing one) was
caught and restored in the same session before any run.

**Commands:** `npx vitest run apps/server packages/server` → 46/46;
`npm run check:fast` → PASS 5/5; `npm run signals -- verify --set
verification` → 7/7 green (receipt:
`.do-harness/evidence.verification.json`). Container smoke
(`do-sift:ops-05-rc` =
`sha256:15625456428ba7d3be28534c9c812a8e8a7cfef2a68615d12b534da68dd46bce`):
built with the service CMD; `docker run` with fixture env → built-in
healthcheck **healthy**; host `GET /healthz` → 200 `{"ok":true}`; host
`POST /api/research` without credentials → **401** (dev bypass correctly
loopback-only across the bridge); startup log announces fixture providers
as synthetic; `docker run` with NO env → refuses with the
`DO_SIFT_OWNERS` message, **exit 1**.

**Risks / open questions:** the entrypoint composes the host directly
(like `runtime.test.ts`); the full kernel/plugin path (capability-gated
storage activation, secret resolution) is how Turso remote arrives —
explicitly refused in the entrypoint for now. `StaticOidcVerifier({})`
means bearer-token auth rejects everything until a real verifier lands —
dev bypass is the only auth path, and it is loopback-only by
construction. Budgets are not yet env-wirable (fixture mode makes no
external calls; budgets enter with live providers). release:check for
v0.1.0 now reports the existing tag — expected sealed-candidate state;
the next candidate needs a version bump. The v0.1.0 release.md packaging
caveat (image CMD = eval runner) is resolved from this commit onward, but
release.md stays as the sealed candidate record.

**Next suggested task:** registry push for v0.1.0 still waits on the
owner's registry choice (GHCR needs a `write:packages` credential; Docker
Hub `dosoft` is logged in). Development-wise: the live-provider gates
(SRC-02/ANS-02, ask-first) are the next feature work; a natural companion
is wiring `DO_SIFT_FETCH_ALLOWLIST` + safe-fetch into the entrypoint when
the first live adapter lands.
