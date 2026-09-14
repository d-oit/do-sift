# Plan 001 — FND: foundation and plugin kernel

Status: done (2026-09-13 — FND-10 closed by spike; exit gate verified below)

Goal: agentic development foundation (plans, skills, scripts harness, CI,
security posture, release skeleton) plus a working plugin kernel v0 with a
sample plugin that activates, grants, and deactivates — before any product
feature.

## Tasks

| ID     | Task                                                                                  | Status | Evidence                  |
| ------ | ------------------------------------------------------------------------------------- | ------ | ------------------------- |
| FND-01 | Repo scaffold: npm workspaces, tsconfig, LICENSE, README, gitignore                   | done   | git init -b main; files   |
| FND-02 | plans/ folder: 000–004, invariants.json, risks, sources, ADRs, templates              | done   | policy.ts validates       |
| FND-03 | AGENTS.md + 7 skills under .agents/skills/                                            | done   | skills-check.ts green     |
| FND-04 | scripts harness: check.ts, policy.ts, skills-check.ts, eval.ts, release-check.ts      | done   | npm run check:fast        |
| FND-05 | packages/contracts: zod schemas for plugin manifest, model, search, harness, evidence | done   | unit tests                |
| FND-06 | packages/kernel: manifest validation, registry, lifecycle, capability grants          | done   | kernel tests              |
| FND-07 | Sample plugin: activate/grant/deactivate round-trip test                              | done   | kernel test               |
| FND-08 | CI/security/scorecard/release workflow skeletons with pinned SHAs                     | done   | .github/workflows         |
| FND-09 | Deliberate failing check verified (policy fails on planted violation, then removed)   | done   | manual log below          |
| FND-10 | dsh/Cordis adoption spike: decision recorded in ADR 0004                              | done   | ADR 0004 addendum + below |

## FND-10 spike record (2026-09-13, spike-runner workflow per plan 009) — outcome: no adoption

**Hypothesis (stated before code):** Cordis — the TypeScript plugin
framework under deepseek-harness — offers concrete lifecycle/context
benefits over the first-party kernel (richer plugin contexts, service
injection, event plumbing) at acceptable dependency risk. Counter-
expectation to test: Cordis ships none of this kernel's security model
(manifest validation, capability grants, deny-by-default activation), so
adoption would add the dependency while the security layer is rebuilt
first-party anyway.

**Method:** isolated scratch under gitignored `.spikes/fnd10-cordis/`
(deleted after findings were recorded). Success = exit code 0 from a scratch
harness that (a) re-implements the kernel round-trip
(register→config→activate→capability-gated operation→deactivate) on
Cordis's real installed API, and (b) completes dependency-risk probes
(release cadence via registry metadata, Python files in the installed
tree). Findings land as an ADR 0004 addendum (sanctioned by that ADR) and
this row; scratch code does not leak into packages/.

**Findings (full detail in the ADR 0004 addendum):**

1. Round-trip PASSED on cordis 4.0.0-rc.10 (`node node_modules/tsx/dist/cli.mjs
.spikes/fnd10-cordis/harness.ts` → exit 0): schema-validated activation,
   invalid-config refusal, ungranted-paid refusal, grant-then-activate,
   dispose — all demonstrated on the real API. Adoption is technically
   viable.
2. But the kernel's actual value is absent from cordis: manifest validation
   is opt-in per plugin `Config` (not a registration-time gate before code
   loads) and capabilities/grants/deny-by-default do not exist — the spike
   re-implemented the INV-003 check inside `apply()`. cordis brings ~1545
   lines of runtime JS + `cosmokit` + `@standard-schema/spec` (4 installed
   packages) vs the first-party kernel's 268 lines of TS over an existing
   dep (zod).
3. Preview-churn CONFIRMED: `latest` = 4.0.0-rc.10 (a release candidate on
   the stable tag; `next` = beta), 166 releases, 13 in the last 6 months,
   newest 5 days before the spike.
4. Python: no `.py` files in the cordis tree — that concern attaches to
   dsh-the-product only. The one criterion cordis passes.
5. Behavioral quirks recorded for the future: schema-invalid configs reject
   the plugin promise with cordis `ValidationError` while `fiber.state`
   stays PENDING; plugin runtimes are keyed by object identity (re-plugging
   one object updates, not reloads); `Fiber` is PromiseLike but not a
   Promise (node `assert.rejects` needs a bridging promise).

**Verdict:** no adoption — the Decision in ADR 0004 stands unchanged.

**Commands:** harness run (exit 0, above); `npm view cordis dist-tags
time --json` (release cadence); `find node_modules/cordis -name "*.py"`
(empty); `wc -l` LOC comparison. Scratch `.spikes/fnd10-cordis/` deleted
after recording.

## FND-09 evidence (deliberate failure rehearsal)

2026-09-06: planted root-level `temp.py`, ran `npm run policy` → FAIL with
`[noPython] authored Python file: temp.py`. Removed file → PASS.

The rehearsal caught a real gap on the first attempt: the initial scan
omitted repo-root files, so a planted root `temp.py` was missed. Fixed by
including the root in `checkNoPython` and `checkNoSecrets` scans, then
re-rehearsed successfully. The check is stronger because of the rehearsal.

## Exit gate

A deliberate policy/test failure fails CI (FND-09); sample plugin round-trips
(FND-07 kernel tests, re-verified green in today's verification signal set);
no secrets in repo (INV-005 enforced by policy + secret scan, green);
`npm run check` green (dev-signal verification set green 2026-09-13, all 7
sensors, receipts under `.do-harness/`). Exit gate met — plan closed.
