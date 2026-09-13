# Plan 001 — FND: foundation and plugin kernel

Status: in-progress

Goal: agentic development foundation (plans, skills, scripts harness, CI,
security posture, release skeleton) plus a working plugin kernel v0 with a
sample plugin that activates, grants, and deactivates — before any product
feature.

## Tasks

| ID     | Task                                                                                  | Status | Evidence                |
| ------ | ------------------------------------------------------------------------------------- | ------ | ----------------------- |
| FND-01 | Repo scaffold: npm workspaces, tsconfig, LICENSE, README, gitignore                   | done   | git init -b main; files |
| FND-02 | plans/ folder: 000–004, invariants.json, risks, sources, ADRs, templates              | done   | policy.ts validates     |
| FND-03 | AGENTS.md + 7 skills under .agents/skills/                                            | done   | skills-check.ts green   |
| FND-04 | scripts harness: check.ts, policy.ts, skills-check.ts, eval.ts, release-check.ts      | done   | npm run check:fast      |
| FND-05 | packages/contracts: zod schemas for plugin manifest, model, search, harness, evidence | done   | unit tests              |
| FND-06 | packages/kernel: manifest validation, registry, lifecycle, capability grants          | done   | kernel tests            |
| FND-07 | Sample plugin: activate/grant/deactivate round-trip test                              | done   | kernel test             |
| FND-08 | CI/security/scorecard/release workflow skeletons with pinned SHAs                     | done   | .github/workflows       |
| FND-09 | Deliberate failing check verified (policy fails on planted violation, then removed)   | done   | manual log below        |
| FND-10 | dsh/Cordis adoption spike: decision recorded in ADR 0004                              | ready  | ADR 0004                |

## FND-09 evidence (deliberate failure rehearsal)

2026-09-06: planted root-level `temp.py`, ran `npm run policy` → FAIL with
`[noPython] authored Python file: temp.py`. Removed file → PASS.

The rehearsal caught a real gap on the first attempt: the initial scan
omitted repo-root files, so a planted root `temp.py` was missed. Fixed by
including the root in `checkNoPython` and `checkNoSecrets` scans, then
re-rehearsed successfully. The check is stronger because of the rehearsal.

## Exit gate

A deliberate policy/test failure fails CI; sample plugin round-trips; no
secrets in repo; `npm run check` green.
