# Plan 016 — CI/CodeQL remediation

Status: in-progress (2026-09-29)

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

| ID    | Task                                                                                                                   | Status                                                                                                          | Owner | Evidence |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| CI-01 | Format and SHA-pin `.github/workflows/codeql.yml` so `check (linux)` and the CodeQL Advanced analyze jobs stop failing | done (2026-09-29)                                                                                               | agent | below    |
| CI-02 | Disable CodeQL default setup so the in-repo, SHA-pinned advanced configuration is authoritative                        | ready — gated on CI-01 reaching `main`; until then default setup is the only configuration that uploads results | agent | pending  |

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
- `gh api repos/github/codeql-action/git/tags/<v4.38.1 tag object>` → annotated
  tag whose target commit is `1c5b675653bb5c22dbe9b12b556ec555138e09fd`; the pin
  uses the commit, not the tag object.
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
- Out of scope for this plan (pre-existing, needs its own decision):
  `npm audit` reports 2 advisories (1 critical, 1 high) from `tar@6.2.1`,
  pulled in by `fastembed@2.1.0` in `packages/storage`. The fix is
  `fastembed@3.0.0`, a breaking change to the retrieval stack governed by
  ADR 0009 — not something to smuggle into a CI fix PR.

Status: CI-01 done; CI-02 pending CI-01 merge.
