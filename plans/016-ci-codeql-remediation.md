# Plan 016 — CI/CodeQL remediation

Status: done (2026-09-29)

Trigger: PR #40 ("Create codeql.yml") merged the stock GitHub CodeQL template
onto `main`. It broke CI three ways and, because the `main` ruleset requires
`check (linux)` with `strict_required_status_checks_policy`, every open pull
request was blocked as collateral.

1. Prettier rejected `.github/workflows/codeql.yml`, so `ci` (`check (linux)`
   and `check (windows, fast)`) failed on `main` — run 36562578177,
   2026-09-29.
2. The workflow used floating tags (`actions/checkout@v7`,
   `github/codeql-action/init@v4`, `github/codeql-action/analyze@v4`). The
   org/repo policy rejects unpinned actions ("all actions must be pinned to a
   full-length commit SHA"), so the `CodeQL Advanced` analyze jobs died during
   "Set up job" — run 36562578077. Every other workflow in this repo is
   already pinned by SHA.
3. CodeQL **default setup** is enabled (`state: configured`) while advanced
   configurations now also exist, so GitHub refuses the advanced uploads:
   "CodeQL analyses from advanced configurations cannot be processed when the
   default setup is enabled". `security` / `codeql (javascript-typescript)`
   has failed for this reason since at least 2026-09-28 — run 36436065840.

## Tasks

| ID    | Task                                                                                                                 | Status            | Owner | Evidence |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ----------------- | ----- | -------- |
| CI-01 | Format and SHA-pin `.github/workflows/codeql.yml` so `check (linux)` and the CodeQL Advanced jobs stop failing       | done (2026-09-29) | agent | below    |
| CI-02 | Disable CodeQL default setup so the in-repo, SHA-pinned advanced configuration is authoritative                      | done (2026-09-29) | agent | below    |
| CI-03 | Dedupe CodeQL: drop the `codeql` job from `security.yml` so `javascript-typescript` is scanned once, by `codeql.yml` | done (2026-09-29) | agent | below    |

## Guard rails

- No edits to `scripts/policy.ts`, `plans/invariants.json`, or the `main`
  ruleset. This plan repairs workflow content that already landed; it does not
  change a check.
- Pin by full commit SHA with the `# vX.Y.Z` comment, matching `ci.yml`,
  `release.yml`, `security.yml`, and `scorecard.yml`.
- Keep `security.yml` untouched: Dependabot PRs #37/#36 pin its `init` and
  `analyze` lines, and unrelated edits there would invalidate both. **Superseded
  by CI-03**, which deletes the job those two PRs edit; #36 and #37 are then
  obsolete and must be closed rather than merged.
- Disable default setup only _after_ CI-01 is on `main`. Until then default
  setup is the only configuration actually uploading CodeQL results, so
  disabling it first would leave the repo unscanned.

### CI-01 evidence — 2026-09-29

Files:

- `.github/workflows/codeql.yml` — prettier formatting; `actions/checkout`
  pinned to `3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`;
  `github/codeql-action/init` and `github/codeql-action/analyze` pinned to
  `1c5b675653bb5c22dbe9b12b556ec555138e09fd # v4.38.1` — the same SHAs
  Dependabot proposes in #39, #37, and #36.

Commands:

- `gh api repos/actions/checkout/git/ref/tags/v7.0.1` →
  `3d3c42e5aac5ba805825da76410c181273ba90b1` (commit).
- `gh api repos/github/codeql-action/git/tags/<v4.38.1 tag object>` — v4.38.1 is
  an annotated tag; its target commit is
  `1c5b675653bb5c22dbe9b12b556ec555138e09fd`, and the pin uses the commit, not
  the tag object.
- `npx prettier --check .github/workflows/codeql.yml` → FAIL before; PASS after
  `npx prettier --write`.
- `git diff -w .github/workflows/codeql.yml` → semantic changes are exactly the
  three `uses:` pins plus `cron` quote style; the remaining 45/45 line delta is
  YAML indentation only.
- `npm run check:fast` → `FAIL prettier` (5 steps run) before; **5/5 PASS**
  after.
- `npm run check` → **7/7 PASS** (prettier, eslint, typecheck, policy, skills,
  tests, evals).
- `npm run signals -- verify --set verification` → **7/7 green**, receipt
  `.do-harness/evidence.verification.json`.
- Shipped as PR #41 (`fix/codeql-workflow`), squash-merged to `main` as
  `2f6bfb2`.

Risks/open questions:

- `codeql.yml` and `security.yml` both analyze `javascript-typescript`, so with
  default setup disabled they can produce duplicate alerts for that language.
  `codeql.yml` additionally analyzes `actions`. Deduplicating them (drop the
  `security.yml` `codeql` job, keep its `dependency-review` job) is a follow-up
  decision, deliberately not bundled here because #37/#36 pin exactly those
  lines.
- `scorecard.yml` still pins `github/codeql-action/upload-sarif` at v4.38.0
  while #37/#36 move `init`/`analyze` to v4.38.1. `upload-sarif` is independent
  of the `init`/`analyze` pair, so this is version drift, not breakage.
- Verified upstream changelogs for the PRs under review: `checkout@v7`'s
  breaking change blocks fork checkout only for `pull_request_target` and
  `workflow_run`, neither of which this repo uses, and every checkout here sets
  `persist-credentials: false`; `upload-artifact@v7`'s new single-file
  `archive: false` mode is opt-in and ignores `name` only in that mode.
- Out of scope for this plan (pre-existing, needs its own decision): `npm audit`
  reports 2 advisories (1 critical, 1 high) from `tar@6.2.1`, pulled in by
  `fastembed@2.1.0` in `packages/storage`. The fix is `fastembed@3.0.0`, a
  breaking change to the retrieval stack governed by ADR 0009 — not something to
  smuggle into a CI fix PR.

### CI-02 evidence — 2026-09-29

Action:

- `gh api -X PATCH repos/d-oit/do-sift/code-scanning/default-setup -f state=not-configured`
  → default setup `configured` → `not-configured`, making the in-repo,
  SHA-pinned advanced configuration authoritative. The call is reversible by
  re-enabling default setup in repository settings.

Commands:

- Diagnostic that fixed the ordering: the "passing" Analyze jobs at
  `pull_request` time were GitHub's default-setup dynamic run
  (`event: dynamic`), while the repository workflow failed at upload with
  "CodeQL analyses from advanced configurations cannot be processed when the
  default setup is enabled" (run 36566413560). So default setup — not the
  workflow — was the remaining fault, and it had to be disabled only once
  CI-01 was on `main`.
- `gh run list --branch main` after CI-01 merged as `2f6bfb2` → `ci` success
  (36566877460), `CodeQL Advanced` success (36566877245), `scorecard` success
  (36566877510). The preceding `main` push runs (36562578177, 36562578077) had
  failed on `ci` and `CodeQL Advanced` respectively.
- `gh pr checks 35` after rebasing the Dependabot queue onto the fixed `main` →
  `check (linux)` pass, `check (windows, fast)` pass, `Analyze (actions)` pass,
  `Analyze (javascript-typescript)` pass. The advanced workflow now uploads
  successfully, confirming CI-01 + CI-02 together.
- `npm run check:fast` on the CI-02 evidence branch → **5/5 PASS** (prettier,
  eslint, typecheck, policy, skills).
- `npm run policy` → **PASS, 6 checks, 0 findings**.
- `npx prettier --check plans/016-ci-codeql-remediation.md plans/README.md` →
  **PASS** ("All matched files use Prettier code style!").

Risks/open questions:

- Disabling default setup removes the fallback configuration. If the advanced
  workflows are ever deleted, code scanning stops silently; that risk is
  covered by `CODEOWNERS` review of `.github/workflows/`, not by an automated
  check.
- **Merge gate — root cause identified.** The `main` ruleset (id 23702255,
  `updated_at` 2026-09-29T11:39:19.376Z) blocks merges through its
  **`code_scanning` rule** — code scanning merge protection — not through
  required status checks. GitHub's documentation for that rule states it is
  unrelated to status checks, and that it blocks a pull request when a required
  tool finds an alert at the configured severity, a required tool's analysis is
  still in progress, **or a required tool is not configured for the
  repository**. The third condition is what is happening: the `CodeQL` check on
  the current heads of #35 (`842b4c4`) and #42 (`05d9113`) is `neutral`, titled
  "1 configuration not found", with the summary "Code scanning cannot determine
  the alerts introduced by this pull request, because 1 configuration present
  on `refs/heads/main` was not found: ... Actions workflow (`security.yml`) →
  `.github/workflows/security.yml:codeql`". The rule is evaluated per head SHA,
  so every pull request needs its own analysis before it can merge.
- The missing configuration is `security.yml`'s `codeql` job. `security.yml`
  was set to `disabled_manually` at 2026-09-28T14:28:28Z, one second after
  GitHub's default-setup `dynamic` run started; default setup then blocked every
  SARIF upload from the advanced workflows. Default setup is now
  `not-configured`, so re-enabling `security.yml` should make the configuration
  determinable again. Two earlier hypotheses are retired:
  `require_extra_approval_for_unattributed_changes` is refuted (#41 was
  bot-authored, had zero reviews, and merged on the same ruleset at
  2026-09-29T12:15:05Z), and #41's own `CodeQL` check was `neutral` — "Error
  when processing the SARIF file" — not a _failing_ analysis, so the earlier
  inference that "a rule that cannot be evaluated is not enforced" did not hold.
  The `code_quality` rule is also inert here: `gh api repos/d-oit/do-sift/code-quality/setup`
  → "Code quality is not available for this repository".
- **Blocked on token scope.** Re-enabling `security.yml` is the remedy and the
  integration credential cannot perform it: `gh workflow enable 362162401`, the
  `PUT .../actions/workflows/362162401/enable` endpoint, and a dispatch probe
  each return 403 "Resource not accessible by integration". Reads succeed, so
  the diagnosis is solid and only the write is refused. It needs either a human
  on Actions → `security` → "Enable workflow", or the Freebuff GitHub App
  gaining **Actions: write**. Do not route around it with a PAT or SSH key.

  **Which scope is missing — measured 2026-09-29, not assumed.** A capability
  probe of the installation token against this repository:

  | Capability                                   | Result  |
  | -------------------------------------------- | ------- |
  | `contents: write` (push a branch)            | OK      |
  | `pull_requests: write` (open/comment/close)  | OK      |
  | `code_scanning: write` (patch default-setup) | OK      |
  | `actions: read` (list workflows)             | OK      |
  | **`actions: write` (enable/dispatch)**       | **403** |

  `gh api repos/d-oit/do-sift --jq .permissions` returns
  `{admin:false, maintain:false, push:false, triage:false, pull:false}` — the
  app holds no repository role, only individually granted scopes, which is why
  a role bump would not help and only the **Actions: write** scope does.
  `GET /app` and `GET /repos/…/installation` both 401 "A JSON web token could
  not be decoded": the credential is a repository-scoped installation token,
  not an app-owner JWT, so the agent cannot inspect or widen the app's own
  permissions. That grant is app-owner/Freebuff-side work.

- `security.yml` declares no `workflow_dispatch`, so there is no "Run workflow"
  button: a controlled run needs a `pull_request` event (a push to a pull
  request branch, or `gh pr update-branch`) or the weekly `cron: "17 3 * * 1"`.
  Do not re-enable default setup while `codeql.yml` exists — per GitHub's docs
  it disables existing CodeQL workflows and blocks analysis uploads, which is
  what produced this state.
- **Ordering hazard (state as of 2026-09-29T12:31Z).** #35 and #42 report
  `BLOCKED`; #36–#39 report `BEHIND`. Auto-merge (SQUASH) is armed on all six,
  so the first one whose gate clears merges immediately. #37 bumps
  `security.yml`'s `init` to 4.38.1 and #36 bumps its `analyze` to 4.38.1, and
  `codeql-action` requires `init` and `analyze` to run the same version — a
  split merge leaves `security.yml` mismatched, the workflow fails, the
  configuration returns to "not found", and the whole queue re-blocks. They must
  land as one unit, so disarm auto-merge on #36 and #37 first.
- If re-enabling works, the duplicate-alert risk recorded under CI-01 becomes
  live: `codeql.yml` and `security.yml` both analyze `javascript-typescript`,
  and two configurations for the same language produce duplicate alerts.
  Dedupe them afterwards, as its own change. **Done as CI-03 below.**
- References:
  <https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection>
  (code scanning merge protection — unrelated to status checks; blocks when a
  required tool is not configured) and
  <https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows>
  (default setup disables existing CodeQL workflows and blocks analysis
  uploads).

### Re-verification — 2026-09-29 (agent, later session)

The `CodeQL` alert is unchanged: `1 configuration not found`. Re-checked live,
no new cause.

- `gh api repos/d-oit/do-sift/check-runs/109449104110` (PR #42) → conclusion
  `neutral`, title `1 configuration not found`, summary "1 configuration
  present on `refs/heads/main` was not found: Actions workflow
  (`security.yml`) → `.github/workflows/security.yml:codeql`". `gh pr checks`
  renders the same check as `skipping` — a display of the same neutral result,
  not a pass.
- `gh api repos/d-oit/do-sift/actions/workflows` → `security` (id 362162401) is
  still `disabled_manually`; `ci`, `CodeQL Advanced`, `release`, `scorecard`
  are `active`.
- `gh run list` → every recent `CodeQL Advanced` run is `success` on both
  matrix languages, so the advanced configuration is healthy; only the disabled
  `security.yml` configuration is missing.
- `gh api repos/d-oit/do-sift/code-scanning/default-setup` → still
  `not-configured` (CI-02 holds; do not re-enable it while `codeql.yml` exists).
- Blocked on the same write, re-probed this session: `gh workflow enable
security.yml` → `HTTP 403: Resource not accessible by integration`. Reads
  (`/actions/workflows`, `/code-scanning/*`) succeed.

Open PRs #35–#39 and #42 are all `BLOCKED`; auto-merge (SQUASH) remains armed
on #35, #38, #39, and #36/#37 are still the pair that must land together.

**Remedy is unchanged and needs one of:** a human on Actions → `security` →
"Enable workflow", or the Freebuff GitHub App gaining **Actions: write**. No
in-repo change can clear it: code scanning matches the missing configuration by
the path+job `security.yml:codeql` that already exists on `main`, and every
content PR is itself blocked by the `code_scanning` ruleset rule (23702255,
`alerts_threshold: errors`), so the job cannot be removed or the file renamed
through a pull request. Weakening or disabling that ruleset rule was rejected:
it is a check, and this repo does not trade a check to pass a gate.

### CI-03 evidence — 2026-09-29 (agent)

Dedupe: `javascript-typescript` is analyzed by `codeql.yml` only. The `codeql`
job is deleted from `security.yml`, which keeps its `dependency review` job.

Files:

- `.github/workflows/security.yml` — removed the `codeql`
  (javascript-typescript) job and its job-level
  `security-events: write` permission; added a comment naming `codeql.yml` as
  the single CodeQL configuration. `dependency review` is byte-identical.
- `plans/016-ci-codeql-remediation.md`, `plans/README.md` — this record.

Why `codeql.yml` is the survivor: it is the newer, fully SHA-pinned workflow
(CI-01) and it is the only one that also analyzes the `actions` language, which
`security.yml` never did. `default setup` is `not-configured` (CI-02), so the
repository has no third configuration to collide with.

Verification:

- `npx prettier --check .github/workflows/security.yml` → **PASS** (prettier
  parses the file as YAML, so the edit is also a syntax check).
- `git diff .github/workflows/security.yml` → the only change is the deleted
  `codeql` job, the deleted `security-events: write` permission that belonged
  to it, and a comment. `dependency review` and both triggers are untouched.
- `npm run check` → **7/7 PASS** (prettier, eslint, typecheck, policy, skills,
  tests, evals). `npm run policy` scans `.github`, so the workflow was checked
  too.
- `npm run signals -- verify --set feedback` → **5/5 green**, receipt
  `.do-harness/evidence.feedback.json`.

Consequences that must be handled, in order:

1. **#36 and #37 become obsolete — CLOSED 2026-09-29.** Both diffs touch only
   the deleted job's `init` / `analyze` lines (`gh pr diff 36`, `gh pr diff
37`), so once this lands on `main` they conflict and were **closed, not
   merged**, each with the reasoning in a closing comment. That also retires
   the CI-02 ordering hazard: their "must land as one unit" constraint
   disappeared with the job they pin — and neither could ever have merged
   alone, since `codeql-action` requires `init` and `analyze` on the same
   version. `codeql.yml` is already at codeql-action `4.38.1`, so no pin is
   lost. Dependabot will re-propose if a future workflow needs the bump.
2. **The gate does not let this PR merge — VERIFIED, not predicted.** The
   re-verification above recorded that the `CodeQL` rule blocks every PR while
   the configuration `security.yml:codeql` is present on `main` and absent from
   the PR's analysis. Shipped as PR #43
   (`ci/016-codeql-dedupe`), and the predicted deadlock is what happened:
   `gh api repos/d-oit/do-sift/check-runs/109493934925` on #43 → conclusion
   `neutral`, title `1 configuration not found`, naming
   `security.yml:codeql` on `refs/heads/main` — while `Analyze (actions)` and
   `Analyze (javascript-typescript)` from `codeql.yml` both pass. So the check
   compares against **`main`**, not the PR head: removing the job in the head
   does not satisfy the rule while `main` still advertises the configuration.
   #43 is `MERGEABLE` but `BLOCKED`.

   The deadlock is real, so the way out is to satisfy the gate **first** and
   land the dedupe second:

   1. A human re-enables `security.yml` on Actions (Actions → `security` →
      Enable workflow), or the Freebuff GitHub App gains **Actions: write** and
      runs `gh workflow enable security.yml`. Its `codeql` job then uploads and
      the configuration becomes determinable, which unblocks #43 and the rest
      of the queue.
   2. Merge #43, which then removes the duplicate for good, and close #36/#37.

   Turning that around — shipping the dedupe first to clear the alert — does not
   work, and this section is the record of having tried it. Weakening or
   disabling the `code_scanning` rule to break the deadlock is rejected: it is
   a check, and this repo does not trade a check to pass a gate.

   The branch also carries the three unmerged docs commits from #42 (CI-02
   evidence and the merge-gate root cause) because CI-03 documents CI-02 and
   cannot stand without it. **#42 was closed as superseded 2026-09-29** — its
   three commits are in this branch, so nothing was lost, and its branch was
   deleted.

3. **Do not re-enable `security.yml`'s CodeQL job** after this lands, and do
   not re-enable CodeQL default setup while `codeql.yml` exists. Either one
   re-creates the duplicate configuration this task removes.

Risks / open questions:

- The `schedule: cron "17 3 * * 1"` trigger is now inert — the only remaining
  job is gated on `github.event_name == 'pull_request'`, so the weekly run
  skips. Left in place as it is harmless and removing it is unrelated cleanup;
  worth folding into the next `security.yml` touch.
- `dependency review` is unaffected and keeps `fail-on-severity: high`; the
  dedupe does not change dependency scanning coverage.
- Dedupe is not yet confirmed on GitHub: it becomes observable only after
  `security.yml:codeql` is gone from `main`. Watch the next `main` push
  (`CodeQL Advanced`) and confirm the ruleset's `CodeQL` check is no longer
  neutral. The check-run read on #43 (`109493934925`) already showed the
  head-side half of that: `codeql.yml` uploads fine, the alert is entirely the
  missing `security.yml:codeql` configuration.

### Queue state — 2026-09-29 (agent), after CI-03 shipped as PR #43

The request was to merge the queue in the correct order with auto-merge off.
Auto-merge is now **disarmed everywhere** and four pull requests remain open,
all `MERGEABLE` against the current `main` (`2f6bfb2`) and all `BLOCKED` by
one policy. Recording the attempts so the next session does not re-derive them.

Done:

- `gh pr merge <n> --disable-auto` on #35, #38, #39 → auto-merge removed from
  all seven PRs (`gh pr list` → `auto=false` everywhere). Nothing will merge
  itself the moment the gate clears.
- **#36 closed** and **#37 closed**, each with a comment recording that the
  diff touches only the deleted job's pin, that neither could merge alone
  (`init`/`analyze` version match), and that `codeql.yml` is already on
  codeql-action 4.38.1.
- **#42 closed as superseded** and its branch deleted; its three docs commits
  already live in #43.

Not done, and why:

- `gh pr merge 43 --squash --match-head-commit 87a8036` → "the base branch
  policy prohibits the merge". The same command on #35, #38, and #39 returns
  the identical refusal. The policy is ruleset `23702255`'s `code_scanning`
  rule, whose whole purpose is to refuse a merge when code scanning cannot
  evaluate it. **Merging these would mean bypassing that control, so it was
  not attempted** — `gh pr merge --admin` was deliberately not used, and
  re-arming `--auto` would only park the PRs on a gate that cannot clear
  (the configuration is missing on `main`, which is what the gate reads).
- Every open PR is already based on the current `main` and reports
  `MERGEABLE` (not `BEHIND`), so no rebase is needed before the gate clears.
  #39 will need a Dependabot rebase **after** #43 lands, because one of its
  two `security.yml` `checkout` hunks targets the deleted job.

Landing order once the gate clears: **#43 first** (it is the only one that
changes what the others mean), then #35 and #38, then #39 last, because it is
the only PR with a hunk that #43 invalidates.

### Post-permission runbook — 2026-09-29 (agent)

Written so the unblock is mechanical once **Actions: write** exists. Two
gotchas are recorded because both cost time to rediscover.

1. `gh workflow enable security.yml` → verify
   `gh api repos/d-oit/do-sift/actions/workflows/362162401 --jq .state` reads
   `active`. This is the exact call that 403s without the scope.
2. **Enabling a workflow does not re-trigger it for already-open pull
   requests.** The four open PRs (#43, #39, #38, #35) would therefore sit
   without a `security.yml` analysis until a new event arrives. `security.yml`
   only triggers on `pull_request` and `schedule: "17 3 * * 1"` (Mondays
   03:17 UTC), so the deterministic options are: wait for the cron, or
   produce a `synchronize` event on a PR branch (an empty commit) — ask before
   doing the latter, since it rewrites a branch someone else owns.
3. Once the `CodeQL` check turns from `neutral` to a real verdict,
   `gh pr checks <n>` should show no `CodeQL` neutral entry. Then merge in
   order: **#43 → #35 → #38 → #39**, each with
   `gh pr merge <n> --squash --match-head-commit <head sha>` so a racing
   update cannot slip in. #39 goes last because one of its `security.yml`
   hunks targets the job #43 deletes and will need a rebase.
4. Confirm: `gh pr list --state open` empty, `gh api .../commits/main` moved
   past `2f6bfb2`, and `security.yml` no longer holds a CodeQL job.
