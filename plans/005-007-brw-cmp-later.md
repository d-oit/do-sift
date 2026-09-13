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
