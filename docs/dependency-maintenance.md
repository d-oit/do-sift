# Dependency maintenance

A lightweight, repeatable loop for npm freshness, vulnerabilities, licenses
and stale transitive dependencies (issue #174). Automated updates stay
reviewed: nothing silently alters baselines or upgrades a major.

## Update bot: Dependabot only

**Dependabot is the single update bot.** No second bot (Renovate, Snyk PRs,
etc.) is installed: two bots duplicate PRs, desynchronize grouping, and
widen the review surface for no signal gain.

Configuration: [.github/dependabot.yml](../.github/dependabot.yml).

- Schedule: weekly, Monday 06:00 UTC, at most 5 open npm PRs.
- `dev-minor-patch` group: dev-only minor/patch bumps in one PR.
- `runtime-minor-patch` group: production minor/patch bumps in a separate
  PR, so runtime changes never hide inside tooling churn.
- `native-sensitive` group: `fastembed*`, `@libsql/*`, `libsql*`,
  `onnxruntime-node*`, `@anush008/*`, `playwright*` stay out of the bulk
  groups. Each arrives as its own PR and requires the full CI matrix.
- Majors are never grouped and never auto-merged. `typescript` majors are
  additionally ignored until typescript-eslint supports the new major in
  stable (plan 044 DRV-03: TypeScript 7 needs the `@typescript/native`
  backend, still canary upstream).
- `@types/node` updates stay manual: the types package must track the
  pinned Node runtime (ADR 0012), so it is reviewed with the runtime pins.
- GitHub Actions pins update weekly through the same file and must keep
  full-length commit SHA pins with `# vX.Y.Z` comments.

There is **no auto-merge policy** in this repository. No workflow merges a
Dependabot PR on its own, and no major upgrade is applied automatically.

## Scheduled scan

Workflow: [.github/workflows/dependency-scan.yml](../.github/workflows/dependency-scan.yml).

- Schedule: `30 6 * * 1` (Monday 06:30 UTC) plus manual dispatch.
- Permissions: `contents: read` only. No secrets are referenced or needed;
  the job reads the public registry and uploads its evidence as an
  artifact (`audit.json` + `dependency-scan-report.md`, 90-day retention).
- Steps: `npm ci`, capture `npm audit --json`, run
  `scripts/advisory-triage.ts` against
  [policies/dependency-exceptions.json](../policies/dependency-exceptions.json),
  then run the offline `deps-check.ts` sensor to prove the lockfile is
  reproducible and in sync with the workspace manifests.
- The scan never runs on `pull_request`, so fork code never executes with
  credentials.

Local reproduction:

```bash
npm audit --json > /tmp/audit.json || true
npx tsx scripts/advisory-triage.ts \
  --audit /tmp/audit.json \
  --exceptions policies/dependency-exceptions.json \
  --report /tmp/dependency-scan-report.md
npx tsx scripts/deps-check.ts
```

## Severity handling

Triage is by severity and exploitability, not by raw count. Implemented in
[scripts/advisory-triage.ts](../scripts/advisory-triage.ts), covered by
[scripts/test/advisory-triage.test.ts](../scripts/test/advisory-triage.test.ts).

- `high` / `critical` without a valid unexpired exception **fails** the
  scan. The finding records the package, severity, fix availability
  (`fix available` vs `no fix available`) and the first advisory links.
- `moderate` / `low` / `info` are reported as notes. They do not fail
  alone; they are reviewed in the weekly pass and fixed in the grouped
  Dependabot PRs.
- A finding with no available fix is still reported with its severity; the
  response is an exception with a mitigation note or a removal plan, not
  silence.
- The triage accepts both the current `vulnerabilities` map and the legacy
  `advisories` map so fixtures can exercise the parser without the
  registry.

## Exceptions: rationale, owner, expiry

File: [policies/dependency-exceptions.json](../policies/dependency-exceptions.json).

Every entry must carry:

| Field                       | Meaning                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | Stable handle, e.g. `EXC-001`. Referenced in scan output.                                                                     |
| `package` and/or `advisory` | `package` matches an npm package name; `advisory` matches a GHSA/CVE id or advisory URL fragment. One of the two is required. |
| `severity`                  | Recorded severity for the weekly review.                                                                                      |
| `rationale`                 | Why suppression is safe (reachability, dev-only path, mitigation). At least 10 characters; a one-liner is a finding.          |
| `owner`                     | Who owns the risk (e.g. `@d-oit`).                                                                                            |
| `expires`                   | `YYYY-MM-DD` expiry. The scan fails on expired entries — renew or remove.                                                     |
| `review`                    | Optional next-review date.                                                                                                    |

Hygiene rules enforced by the script:

- Malformed entries (missing rationale/owner/expiry) fail as
  `invalid-exception`.
- Expired entries fail as `expired-exception` and the underlying advisory
  fails again on its own.
- Entries matching nothing in the current audit fail as `stale-exception`
  and must be removed — the file cannot outlive the fix. This mirrors the
  `KNOWN_DEPRECATED` rule in `scripts/deps-check.ts` (plan 044 DRV-07).

SLA: `critical` with a fix available is patched or excepted within 7 days;
`high` within 30 days; `moderate` rides the next weekly group unless the
weekly review shortens it. Exceptions expire in at most 90 days.

## Direct support, deprecation, and Node/native compatibility

- The offline `deps` sensor (`scripts/deps-check.ts`, plan 044 DRV-07)
  runs on every `npm run check`: every workspace manifest must resolve in
  the lockfile, no resolved package may be deprecated except the two
  documented upstream blocks (`boolean`, `@anush008/tokenizers` via
  `fastembed` → `onnxruntime-node@1.21.0`), and every `overrides` entry
  must still match exactly one resolved version.
- The weekly review (`plans/044-dependency-review-2026-11.md` is the last
  full pass) checks `npm outdated`, registry deprecation flags, and
  support windows for direct dependencies, including the Node release
  schedule and native prebuild availability (N-API `napi-v3` stability for
  `@libsql/client` / `onnxruntime-node`; `@anush008/tokenizers` has no
  linux-arm64 prebuilt, blocking that deploy target).
- `@types/node` tracks the Node floor (currently 24 LTS, ADR 0012). The
  `.nvmrc`, `engines`, `volta`, `Dockerfile` and CI matrix move together;
  see [upgrading.md](upgrading.md).

## Merging a dependency PR

1. Require the full check on the PR: `npm ci`, `npm run check`
   (prettier, eslint, typecheck, policy, guardrails, skills, governance,
   links, deps, tests, evals, build) on all supported Node lines — the CI
   matrix runs 24 and 26, Windows runs `check:fast`.
2. Runtime dependency updates additionally require tests, build and the
   offline evals (`npm run eval:offline`) green on every supported Node
   line before merge. Native/runtime-sensitive updates (`fastembed`,
   `@libsql/client`, `playwright`, tokenizer and ONNX pins) always take
   this path, including the Playwright browser reinstall check (plan 044
   DRV-05: a hollow browser skip is a failure, not a pass).
3. Review the transitive diff (`package-lock.json`) and the license list
   for release-critical packages. A license change, a new network-capable
   transitive, or a native binary change needs an explicit note in the PR.
4. Do **not** merge (and never auto-merge) a dependency PR that alters
   runtime startup, native bindings, migrations, policy evaluation, auth
   or provider behavior without a dedicated review note and, where the
   change class requires it, a security review per the `review-security`
   skill. When in doubt, ask the maintainer — publishing, paid APIs,
   destructive migrations, new capabilities and workflow/policy changes
   are approval-gated per `AGENTS.md`.
5. Keep the lockfile reproducible: `npm ci` must pass from a clean tree,
   and `npm run release:check` must still pass (version consistency,
   changelog entry, migration chain, no existing tag).

## License review

- Root license is MIT (`LICENSE`, `package.json`). Workspace and release
  artifacts must stay compatible with it.
- When updating release-critical packages (server entrypoint, storage,
  kernel, provider plugins), compare the license set before and after
  (`npm ls --json` / lockfile `license` fields) and call out additions or
  changes in the PR. Content licenses (CC BY-SA for Wikipedia evidence,
  CC BY-NC-SA for Marginalia metadata) are recorded in `plans/sources.md`
  and are unaffected by npm bumps, but a provider-terms change is still a
  review trigger.
- Unfamiliar or copyleft transitive licenses in the runtime path are a
  merge blocker until the maintainer clears them.

## Evidence

- Weekly scan artifact: `dependency-scan-<run-id>` (audit JSON + triage
  markdown, 90 days).
- Bot selection and grouping: this document plus
  `.github/dependabot.yml` comments.
- Last full manual review: `plans/044-dependency-review-2026-11.md`
  (minimatch override, Node 24 floor, TypeScript 6 decision, Vitest pin,
  Playwright bump, fastembed deprecation blocks, offline deps sensor).
- Verification for this loop: workflow permission audit (least privilege,
  no secrets), the advisory parser fixture tests
  (`scripts/test/advisory-triage.test.ts`), and the standing gates
  `npm ci`, `npm run check`, `npm run release:check`.
