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

| ID    | Task                                                                                                           | Status            | Owner | Evidence |
| ----- | -------------------------------------------------------------------------------------------------------------- | ----------------- | ----- | -------- |
| CI-01 | Format and SHA-pin `.github/workflows/codeql.yml` so `check (linux)` and the CodeQL Advanced jobs stop failing | done (2026-09-29) | agent | below    |
| CI-02 | Disable CodeQL default setup so the in-repo, SHA-pinned advanced configuration is authoritative                | done (2026-09-29) | agent | below    |

## Guard rails

- No edits to `scripts/policy.ts`, `plans/invariants.json`, or the `main`
  ruleset. This plan repairs workflow content that already landed; it does not
  change a check.
- Pin by full commit SHA with the `# vX.Y.Z` comment, matching `ci.yml`,
  `release.yml`, `security.yml`, and `scorecard.yml`.
- Keep `security.yml` untouched: Dependabot PRs #37/#36 pin its `init` and
  `analyze` lines, and unrelated edits there would invalidate both.
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
  Dedupe them afterwards, as its own change.
- References:
  <https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection>
  (code scanning merge protection — unrelated to status checks; blocks when a
  required tool is not configured) and
  <https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows>
  (default setup disables existing CodeQL workflows and blocks analysis
  uploads).
