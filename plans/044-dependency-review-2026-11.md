# Plan 044 — Dependency review (2026-11-09): advisories, runtime pin, majors

Status: review complete (2026-11-09). DRV-01 landed as
`plans/043-minimatch-ghsa-g3hv.md` (#142); DRV-02 (Node 24 floor) as #143;
DRV-04, DRV-05 and DRV-07 as #145. DRV-03 is done: `typescript` moves to
`~6.0.3` on top of #149's `types: ["node"]`, with TypeScript 7 deferred.
DRV-06 remains blocked upstream.

Task IDs here are `DRV-*` because plan 043 already used `DEP-0N` for the
minimatch override.

## Context

A weekly dependency review of the root `package.json` plus 22 workspace
manifests (`packages/*`, `packages/plugins/*`, `apps/*`), `package-lock.json`
(lockfile v3, 301 resolved packages), `.nvmrc`, the `Dockerfile`, and the four
CI workflows. Sources are the npm registry, `npm outdated`/`npm audit`, the
GitHub REST API, and `nodejs.org/dist`; each claim below carries the check that
produced it.

The tree is internally consistent: `npm ls --depth=0` reports no missing,
invalid, or peer-conflict edges. Most direct dependencies are already at
latest (`zod` 4.6.7, `eslint` 10.14.0, `prettier` 3.9.10, `tsx` 4.23.15,
`typescript-eslint` 8.72.1, `@vitest/coverage-v8` 5.1.0, `@libsql/client`
0.18.0, `fastembed` 3.0.0). The tasks below are the exceptions, ordered by
risk.

## Tasks

| ID     | Task                                                                                                                                                                                                  | Status                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| DRV-01 | Resolve the `minimatch` advisory cluster (9 moderate) without downgrading eslint: decide on an `overrides` entry for `minimatch ^11.0.1`, then verify with `npm run check` and `npm run eval:offline` | done (plan 043, #142)         |
| DRV-02 | Align `@types/node` with the shipped runtime and refresh the Node pins to Node 24 LTS (ADR 0011)                                                                                                      | done                          |
| DRV-03 | Decide the TypeScript major: migrate to `6.0.3` (top of the `typescript-eslint` peer window) or hold at 5.9.3 until it supports 7.x, and record the choice                                            | done: `~6.0.3`; TS 7 deferred |
| DRV-04 | Pin `vitest` and `@vitest/coverage-v8` identically (caret vs exact while coverage peer-requires an exact match)                                                                                       | done                          |
| DRV-05 | Bump Playwright `1.64.1` → `1.65.0` and re-run `npx playwright install`, proving the BRW-04 e2e did not silently skip                                                                                 | done                          |
| DRV-06 | Track fastembed's deprecated transitives (`boolean` via the exact `onnxruntime-node@1.21.0` pin; archived `@anush008/tokenizers`) and the arm64 prebuild gap                                          | blocked                       |
| DRV-07 | A `deps` gate sensor: fails on a deprecated resolution, an unresolved workspace, or an inert `overrides` entry; runs offline so freshness is a receipt, not a manual pass                             | done                          |

## Findings and sources

### DRV-01 — minimatch advisory cluster (highest signal value)

`npm audit` → 9 moderate, 0 high, 0 critical. All nine entries resolve to a
single advisory: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
(CVE-2026-118764, CWE-405, "potential DoS via globparts amplification",
vulnerable `>=7.0.0 <11.0.1`, patched `11.0.1`).

Path, from the lockfile: `eslint@10.14.0` → `@eslint/config-array@0.23.5` and
`eslint` directly → `minimatch ^10.2.x`; `typescript-eslint@8.72.1` →
`@typescript-eslint/typescript-estree` → `minimatch ^10.2.2`. One resolution:
`minimatch@10.2.6`, flagged dev-only.

Two facts constrain the fix:

- No fixed 10.x exists. `10.2.6` is the last 10.x published; the patch landed
  in 11.0.1. So the remedy is an `overrides` entry, not a version bump.
- `npm audit fix` proposes **downgrading `eslint` to 9.39.5** as semVer-major.
  That must not be taken: eslint 10.14.0 already sits inside typescript-eslint
  8.72.1's `eslint` peer range (`^8.57.0 || ^9.0.0 || ^10.0.0`), so the
  downgrade buys nothing and reverses a deliberate upgrade.

Why it matters despite low exploitability: nine rows of the same advisory
drown out the next real one, and the glob patterns come from repo config
rather than fetched content. The value is a clean audit signal.

Risk if overriding: the [minimatch 11.0 changelog](https://github.com/isaacs/minimatch/blob/main/changelog.md)
removes `makeRe()`, the `AST` class, `maxExtglobRecursion`, and the `debug`
option. eslint and typescript-eslint consume minimatch internally, so the
override must be validated by the sensors, never assumed safe.

### DRV-02 — Node floor moved to 24 LTS (done)

The four pins disagreed, and the disagreement was the risk:

- Types: `@types/node: ^24.0.0` → locked `24.13.3`, describing the Node 24 API.
- Runtime: `.nvmrc` `22`; `engines.node` `>=22`; `volta.node` `22.14.0`;
  `Dockerfile` `node:22-slim`; CI matrix `[22, 24]`.

`@types/node` was ignored in `.github/dependabot.yml` with the comment "must
track the pinned Node runtime; reviewed separately". That review had lapsed:
types described Node 24 while Volta developers and the container ran Node 22.

`volta.node` `22.14.0` (2025-02-11) predated **7 Node 22 security releases**,
newest `v22.23.4` (2026-10-20), per `https://nodejs.org/dist/index.json`.
`.nvmrc`'s floating `22` and `node:22-slim` pick up fixes; the Volta pin does
not, and no sensor reads it.

Per the [Node release schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json),
Node 22 entered maintenance on 2025-10-21 (EOL 2027-04-30); Node 24 is active
LTS (maintenance 2026-10-20, EOL 2028-04-30). `docs/upgrading.md` had still
labelled Node 22 "Active LTS".

Decision: **Node 24 is the floor** (owner, 2026-11-09), recorded as ADR 0011.
`engines: ">=22"` also admitted non-LTS 23/25, which `>=24` stops.

Native-ABI check performed before the decision: `@libsql/client` and
`onnxruntime-node` ship Node-API `napi-v3` prebuilts (`node_modules/onnxruntime-node/bin/napi-v3`),
which are stable across majors, so no rebuild is implied by the move.

### DRV-03 — TypeScript is three majors behind but peer-blocked

Installed `5.9.3` (spec `^5.6.0`); registry latest `7.0.2` (2026-07-08), with
`6.0.2`/`6.0.3` as the only stable 6.x releases (2026-04-16).

`typescript-eslint@8.72.1`, itself the latest, declares
`typescript: ">=4.8.4 <6.1.0"`; `@typescript-eslint/parser` and `eslint-plugin`
carry the same range. **TypeScript 7 cannot be installed without failing
`npm run check`.** The highest version inside the window is `6.0.3`, still
above the current `^5.6.0`.

Blocker and next decision: absorb the TS 6 migration now (bump to `~6.0.3`,
expect `exactOptionalPropertyTypes` and `verbatimModuleSyntax` fallout across
23 manifests) or hold at 5.9.3 and pin `typescript-eslint` until it widens the
peer range. Resolve before any Dependabot bump tries 7.x.

**Update (2026-11-11): the premise above was wrong.** typescript-eslint will not
widen its `typescript` peer range to admit 7. Upstream closed "TypeScript 7.0.2
Support" ([typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518))
as not planned: TS 7.0 ships no JS API, and the TypeScript team expects 7.1 to ship
a new, different one. Support is instead being built as a separate optional peer,
`@typescript/native` (an alias for `typescript@>=7.1.0-beta`), behind
`projectService.EXPERIMENTAL_backend`. That merged in
[typescript-eslint#12803](https://github.com/typescript-eslint/typescript-eslint/pull/12803)
on 2026-11-10 and is in canary `8.72.3-alpha.7`, not in stable `8.72.2`. The
`typescript` peer stays `>=4.8.4 <6.1.0` throughout, and the backend only affects
type-aware linting, which this repo does not use (`tseslint.configs.recommended`
only). TS 6 was therefore never blocked; it was a decision.

### DRV-04 — latent spec mismatch in the Vitest pair

`vitest: ^5.0.3` (caret) but `@vitest/coverage-v8: 5.1.0` (exact), while
vitest 5.1.0 peer-requires `@vitest/coverage-v8: 5.1.0` exactly. Both resolve
to 5.1.0 today so nothing is broken, but the caret lets a future 5.x bump of
vitest desync from the coverage package's exact peer pin.

### DRV-05 — Playwright one minor behind

`packages/browser-driver` declares `^1.64.1`; `npm outdated` reports
wanted/latest `1.65.0` ([released 2026-11-05](https://github.com/microsoft/playwright/releases/tag/v1.65.0)),
so a plain `npm install` already moves it. Repo-specific caveat: the BRW-04
e2e in `packages/browser-driver/test/playwright-driver.test.ts` catches a
launch failure and returns early with a warning, so a green run does not prove
the installed chromium matches the new driver. `npx playwright install` must
run alongside the bump and the skip path must be inspected.

### DRV-06 — deprecated transitives in the production embedding path

Both arrive through `packages/storage` → `fastembed@3.0.0`, which is itself
latest, so no direct upgrade clears them:

- `boolean@3.2.0` ("Package no longer supported"). Path: `fastembed` →
  `onnxruntime-node@1.21.0` (pinned **exactly**, not a range) →
  `global-agent@3.0.0` / `roarr`. `onnxruntime-node@1.31.1` exists and its
  `global-agent@^4.1.3` no longer depends on `boolean`, so a fastembed release
  that lifts the exact pin removes it. Forcing it via `overrides` would cross
  10 minor ONNX runtime releases and native prebuild ABI changes: monitor, do
  not override.
- `@anush008/tokenizers@0.0.0`, archived 2023-09-16, deprecation text pointing
  at the official `@huggingface/tokenizers` (`0.2.0`). It ships prebuilds for
  `linux-x64-gnu`, `win32-x64-msvc`, and `darwin-universal` only.
  **This is a hard blocker for arm64**: ADR 0001 names "linux arm64" as the
  deploy candidate, and no tokenizer binary exists for it. Note
  `packages/storage/src/fastembed-embedder.ts` already bypasses fastembed's
  model download, so only the tokenizer side is exposed.

### Verified clean

All five GitHub Actions pins are current and SHA-verified against their
upstream tags: `actions/checkout@v7.0.1`, `actions/setup-node@v7.1.0`,
`actions/upload-artifact@v7.0.2`, `ossf/scorecard-action@v2.5.0`,
`github/codeql-action@v4.39.3`. No Python or Cargo manifests exist, consistent
with INV-001.

## Evidence — review run (2026-11-09)

Windows 11, Node v24.9.0, npm 11.17.0. Read-only throughout:

- `npm outdated --long` → three rows: `@types/node` 24.13.3 → 24.19.2/26.6.6,
  `playwright` 1.64.1 → 1.65.0, `typescript` 5.9.3 → 7.0.2.
- `npm audit --json` → 9 moderate / 0 high / 0 critical, all via
  `minimatch`; `metadata.dependencies` 99 prod, 190 dev, 71 optional.
- `npm ls --depth=0` filtered for `invalid|peer|missing|ERR` → no output.
- Registry reads for all 12 direct dependencies plus `minimatch` 10.2.6 vs
  11.0.5 metadata; deprecation sweep over all 301 resolved names → two
  deprecated packages (`boolean`, `@anush008/tokenizers`).
- GitHub API: latest releases for five actions, and `git/ref/tags/<tag>`
  SHA comparison for each pin → all MATCH.
- `nodejs.org/dist/index.json` and `nodejs/Release` schedule.json → the
  Node 22/24 status and security release counts cited above.

No files, lockfile entries, or dependencies were changed by the review itself.

## Evidence — DRV-02 (2026-11-09, branch `chore/DRV-02-node-24-floor`)

Files: `.nvmrc`, `package.json` (`engines`, `volta`, `@types/node`),
`package-lock.json` (`@types/node` 24.13.3 → 24.19.2, `undici-types`
7.18.2 → 7.24.6 only), `Dockerfile`, `README.md`, `docs/upgrading.md`,
`docs/decisions/README.md`, `docs/decisions/0012-node-24-floor.md`,
`plans/adr/0011-node-24-floor.md`, `tests/unit/upgrading-docs.test.ts`,
`plans/README.md`.

Commands (Windows 11, Node v24.9.0, worktree on NTFS `C:\git\do-sift-dep02`
because the D: checkout is ReFS and the file tools cannot write there):

- `npm install --package-lock-only` → lockfile resynced; diff confined to
  the `@types/node` and `undici-types` entries (18 lines).
- `npm ci` → clean install on Node 24.
- `npm run build` → `tsc -b tsconfig.build.json`, exit 0.
- `npm run check` first run → **FAIL** prettier (3 new files) and tests:
  `tests/unit/upgrading-docs.test.ts` 3 failed, the docs-contract test
  pinning the old floor (`.nvmrc` `^22`, `engines` `>=22`, README
  `Requires Node >= 22`).
- Test moved with the decision: it now asserts the Node 24 floor, and its CI
  assertion accepts any matrix containing 24 rather than requiring the exact
  literal `[22, 24]`, so the workflow stays editable.
- `npx prettier --write` on the new and flagged files.
- `npm run check` second run → **PASS all 11 steps** (prettier, eslint,
  typecheck, policy, guardrails, skills, governance, links, tests, evals,
  build), 990/990 tests.
- `npx vitest run tests/unit/upgrading-docs.test.ts` → 5/5 passed.
  The `links` and `governance` sensors accepted the new ADR and its
  `docs/decisions` index row.
- Rebased onto `main` after #140 landed the plans 040/041 work this branch
  was cut from, and renumbered to 043: `main` had already published
  `042-guardrails-docs-closeout.md`, and plan numbers are unique forever.
  Re-verified on the rebased base: `npm run check` → PASS all 11 steps.

Risks/open questions:

- `engines.node: ">=24"` is a breaking change for operators on Node 22; the
  release notes must call it out.
- The CI matrix change (`.github/workflows/ci.yml` → `[24, 26]`) was made
  in this slice on explicit owner approval; it is an AGENTS.md
  stop-and-ask boundary and was deliberately excluded from the first pass.
  **Open blocker:** the `main` branch ruleset (id 23702255) requires a
  status check named `check (linux, node 22)`, which a `[24, 26]` matrix no
  longer produces, so the ruleset must be updated to
  `check (linux, node 24)` before this can merge.
- Moving the Docker base to `24-slim` means `npm run eval:offline` inside the
  image build runs on 24 for the first time. `npm run check` does not include
  that step, so a container build is the only evidence for it.

### DRV-06 addendum — arm64

ADR 0001 lists "linux arm64" as the deploy candidate. Since the archived
tokenizer ships no arm64 prebuilt, an arm64 deploy is blocked until fastembed
(or the embedder) stops depending on `@anush008/tokenizers`. Filed here rather
than as a new plan so the dependency record stays in one place.

## Evidence — DRV-04 and DRV-05 (2026-11-09, branch `chore/dep-04-05-pins`)

Files: `package.json` (`vitest` → `5.1.0`), `packages/browser-driver/package.json`
(`playwright` → `^1.65.0`), `package-lock.json` (diff confined to
`playwright`/`playwright-core` and the `vitest` spec), and
`packages/browser-driver/test/playwright-driver.test.ts`.

Commands (Windows 11, Node v24.9.0):

- `npm install` → `playwright` and `playwright-core` both `1.65.0`.
- `npx playwright install chromium` → downloaded chromium 1254 (Chrome for
  Testing 158.0.8127.18) plus headless shell and ffmpeg 1013.
- `npx vitest run packages/browser-driver/test/playwright-driver.test.ts` →
  3/3 passed; the launch test now takes **284 ms** (a real browser) instead
  of the previous **1 ms** (a silent no-op).
- `npm run check` → PASS all 11 steps, 990/990 tests.

**The bug found along the way.** DRV-05 was filed as a one-minor bump, but
the e2e was already hollow: installed Playwright 1.64.1 wanted chromium
**1248** while the machine cache topped out at **1243**, so the `beforeAll`
launch threw, `browserAvailable` went false, and each test hit a
leading `if (!browserAvailable) return;`. Vitest reports an early `return`
as a **pass**, so three tests were green in 0–1 ms without launching
anything — including the two guard tests, which do genuinely need a live
driver and were therefore never running either.

The test now distinguishes the two cases:

- The launch test **throws** with `npx playwright install chromium` in the
  message when chromium is missing, so a missing browser fails CI instead of
  passing silently.
- The two guard tests keep their skip (they need a live `driver`), but are
  now reached only after the launch test has proven a browser exists, so
  they can no longer pass vacuously.
- A deliberate opt-out exists for machines without chromium:
  `DO_SIFT_ALLOW_BROWSER_SKIP=1 npx vitest run` (an env var, not a CLI
  flag: vitest rejects unknown options).

Risks / open questions:

- CI now installs chromium before the test step
  (`npx playwright install --with-deps chromium` in `.github/workflows/ci.yml`,
  Linux job), so the BRW-04 launch test genuinely executes in CI. Both legs
  went from ~1m20s to ~1m55s for the download. Windows stays on
  `check:fast`, which runs no tests, so it is unaffected. The workflow edit
  was made on explicit owner approval (AGENTS.md stop-and-ask boundary).
- `npx playwright install` also pruned the stale 1243 build from the local
  cache, so any other checkout expecting that revision must re-install.

## Evidence — DRV-07 (2026-11-09, branch `chore/dep-07-deps-sensor`)

Files: `scripts/deps-check.ts` (new), `scripts/test/deps-check.test.ts` (new,
13 tests), `scripts/check.ts`, `scripts/dev-harness/sensors.ts`,
`do-harness.toml`, `docs/contributing-guide.md`,
`docs/decisions/0010-dev-signal-harness.md`, this plan, `plans/README.md`.

**Scope decision.** DRV-07 as filed proposed failing on a moderate+ `audit`
result. That check needs the npm registry, and INV-006 makes the pipeline
deterministic and network-free — a gate that goes red when a registry is
slow would be turned off within a week. Worse, an `audit` gate grades the
advisory advisory state, not this repo: **#142's `minimatch` override now
resolves `minimatch@11.0.5`, but `npm audit` still reports 9 moderate
entries** because it maps advisories onto the declared dependency ranges,
not the overridden resolution. A sensor that fails on a fixed problem is
worse than no sensor.

So the sensor gates what is decidable offline and rots silently:

1. every workspace manifest resolves in the lockfile;
2. no resolved package is flagged `deprecated`, except two documented
   upstream blocks (`boolean`, `@anush008/tokenizers`) — and the sensor
   fails if one of those disappears, so the note cannot outlive the problem;
3. every `overrides` entry still matches exactly one resolved version, so a
   dead override (R-20's removal condition) cannot linger.

Zero manifests or zero resolved packages is a failure (INV-006).

Commands (Windows 11, Node v24.9.0):

- `npx tsx scripts/deps-check.ts` → `deps: PASS (307 resolved packages,
22 workspace manifests, 2 documented upstream blocks, 1 override(s))`.
- `npx vitest run scripts/test/deps-check.test.ts` → 13/13 passed, including
  a deprecated package, a stale documented block, an unresolved workspace,
  an inert override, a double-resolution override, and both vacuous-scan
  cases.
- `npm run check` → PASS all 12 steps (prettier, eslint, typecheck,
  policy, guardrails, skills, governance, links, **deps**, tests, evals,
  build), 1003/1003 tests. `deps` itself: 548 ms.
- Wiring the sensor caught a real gap in `stale.ts`: `isSensorInput` has a
  `default: return true`, so the new `deps` sensor initially claimed **every
  file** as an input, and the feedback set started invalidating on unrelated
  edits (the `stale.test.ts` set-isolation case failed). Fixed by giving
  `deps` its own case (lockfile, manifests, its own script).

Risks / open questions:

- The registry-facing half of the review (is a newer version published?)
  stays manual; this sensor cannot see it without network. DRV-07's title
  now says so rather than implying full coverage.
- `KNOWN_DEPRECATED` is a hard-coded allowlist. That is deliberate — it
  makes each tolerated deprecation a visible, dated decision — but it means
  a new transitive deprecation fails the gate until someone records it.

## Evidence — DRV-03 (2026-11-11)

Registry and upstream, read-only: `typescript-eslint@8.72.2` and canary
`8.72.3-alpha.7` both declare `typescript: ">=4.8.4 <6.1.0"`. I downloaded both
`typescript-estree` tarballs: `8.72.2` has no tsgo code; `8.72.3-alpha.7` has 17
files of it, with `@typescript/native` as an optional peer.

Dry-run in a throwaway `git archive` copy of `main` (`956b398`), same commands each
time (`tsc -p tsconfig.json --noEmit`, `tsc -b tsconfig.build.json --force`,
`eslint .`):

| Setup                        | typecheck | build                | lint |
| ---------------------------- | --------- | -------------------- | ---- |
| TS 5.9.3 (baseline)          | pass      | pass                 | pass |
| TS 6.0.3, no change          | pass      | **fail, 111 errors** | pass |
| TS 6.0.3 + `types: ["node"]` | pass      | pass                 | pass |
| TS 5.9.3 + `types: ["node"]` | pass      | pass                 | pass |

In the repo, `npm run check` is 12/12 on TS 6.0.3 (1003 tests, evals and build
included), with no TypeScript diagnostic or deprecation line in the log. The
lockfile diff is the `typescript` entry only. npm resolved 6.0.3 against
typescript-eslint 8.72.1 with no peer conflict and without `--force`.

Findings:

- TS 6 does not auto-include `@types/*`. Without `types: ["node"]` the per-package
  build fails: `safe-fetch` 74, `contracts` 16, `auth` 14, `kernel` 4,
  `fake-providers` 3. This is inferred from the behaviour and the TS2591 text, not
  from the release notes. It landed first as #149 because it is a no-op on 5.9.3.
- The root typecheck masks it: `--explainFiles` shows `@types/node` reaching that
  program only through third-party references (`fastembed`, `undici-types`).
  `check:fast` has no build step, so it would stay green on TS 6 while the build is
  red, and the Windows CI leg runs only `check:fast`.
- The spec is `~6.0.3`, not `^6`, because typescript-eslint caps `typescript` below
  6.1.0.

Deferred: TypeScript 7. It cannot be the `typescript` package typescript-eslint
resolves; the only route today is side by side with TS 6. The gain here is small
(typecheck and build take seconds). Revisit when typescript-eslint stable ships the
7.1 backend and TS 7.1 is stable.

## Risks

- The `minimatch` override (DRV-01) is the one fix that can plausibly break
  the lint/typecheck sensors; it is dev-only, so runtime is unaffected.
- DRV-03 is done, but Dependabot will likely keep proposing `typescript` 7.x
  majors that fail the typescript-eslint peer check. An `ignore` entry for major
  updates in `.github/dependabot.yml` is the follow-up; it is not made here.
- DRV-06 is entirely upstream. Both deprecations are latent, not exploitable,
  but the arm64 tokenizer gap is a hard blocker for the deploy candidate named
  in ADR 0001.
