# Plan 040 — Register the guardrails sync gate as a dev-signal sensor

Status: done (2026-11-09, PR #140 squash-merged as 33f50b8); opened from the 2026-11-09
weekly maintenance review.

## Context

Plan 039 (PR #138) added `scripts/guardrails-check.ts`, the Rego-export
sync gate, as a `guardrails` step in `scripts/check.ts`. It was not
registered in either dev-signal harness: `scripts/dev-harness/sensors.ts`
(the enforced `npm run signals` path) and `do-harness.toml` (upstream
`do-harness`, ADR 0008). As a result `npm run signals -- verify --set
feedback` and `do-harness verify` can report green while
`policies/guardrails.rego` has drifted from
`packages/contracts/src/guardrails.json`; only `npm run check` catches it.

`scripts/dev-harness/test/harness-config.test.ts` already pins
`do-harness.toml` ↔ `SENSOR_DEFS`, but nothing pinned `SENSOR_DEFS` ↔
`scripts/check.ts`, which is how the gap landed unnoticed. The `links`
sensor (plan 036) is the precedent for the wiring.

## Tasks

| ID     | Task                                                                                                                       | Status |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| GRS-01 | Red: parity test (every `scripts/*.ts` step in `scripts/check.ts` is a sensor); pin `guardrails` in sensor/CLI/stale tests | done   |
| GRS-02 | `guardrails` in `SENSOR_DEFS` after `policy` (feedback/verification/release); staleness inputs in `stale.ts`               | done   |
| GRS-03 | `guardrails` sensor + all three signal sets in `do-harness.toml`                                                           | done   |
| GRS-04 | `dev-signals` skill lists the new feedback sensor and verification count                                                   | done   |
| GRS-05 | Verify: dev-harness tests, `npm run signals -- verify --set feedback`, `npm run check:fast`                                | done   |

## Decisions

- Order mirrors `scripts/check.ts` (`policy` → `guardrails` → `skills`), as
  the registry contract in `sensors.ts` requires.
- Staleness inputs: the checker, `guardrails.json`, `guardrails.rego`, and
  `package.json` (tsx toolchain), matching the narrow per-sensor style of
  `policy`/`skills`.
- No change to `scripts/check.ts`, `scripts/policy.ts`,
  `plans/invariants.json`, or `.github/workflows` (approval boundaries).
- Cross-platform (Windows, Linux, macOS, WSL2): the sensor argv uses the
  same `process.execPath`/`node` + `tsx` entrypoint as every other sensor (no
  shell), the checker resolves paths with `node:path`, the staleness map
  normalizes `\` to `/` (pinned by a backslash-path test), and
  `.gitattributes` forces LF on `guardrails.rego`. Path literals match the
  tracked casing, so case-sensitive file systems behave the same.

## Out of scope (follow-ups from the 2026-11-09 review)

- Unit tests for `scripts/guardrails-check.ts` itself (taken up in plan 041: drift, comment-only
  match, stale extra Rego entries).
- `CHANGELOG.md` entry for the Rego export (#138); `plans/README.md` row
  for plan 039 (taken up in plan 042).
- `check:fast` comment lines in `README.md`, `llms.txt`, and
  `docs/contributing-guide.md` omit `guardrails` (taken up in plan 042).

## Evidence (2026-11-09, base 375c12a = origin/main)

Files: `scripts/dev-harness/sensors.ts`, `scripts/dev-harness/stale.ts`,
`do-harness.toml`, `.agents/skills/dev-signals/SKILL.md`,
`scripts/dev-harness/test/{sensors,cli,stale}.test.ts`, this plan,
`plans/README.md`.

Commands (Windows 11, Node v24.9.0):

- Red: `npx vitest run scripts/dev-harness/test/{sensors,cli,stale,harness-config}.test.ts`
  → 8 failed / 40 passed, all on the missing `guardrails` sensor; the parity
  test named `scripts/guardrails-check.ts`.
- Green: same command → 4 files, 48/48 passed.
- `npm run signals -- verify --set feedback` → verdict green, 8 sensors
  including `guardrails` PASS.
- `npm run check:fast` → 8/8 PASS.

Commands (WSL2 Ubuntu, Linux 6.18 microsoft-standard-WSL2, Node v22.23.2;
fresh clone in `/tmp` + `npm ci --ignore-scripts`):

- Same vitest command → 4 files, 48/48 passed.
- `npm run signals -- verify --set feedback` → verdict green, `guardrails` PASS.

Not run: upstream `do-harness verify` (binary not installed on this host;
the TOML is pinned to `SENSOR_DEFS` by `harness-config.test.ts`); full
`npm run check` / verification set; macOS.

## Risks

- macOS is not exercised: CI runs Linux and Windows only. Adding a macOS
  job means changing `.github/workflows` (approval boundary) — owner
  decision.

- Receipts recorded before this change lack the `guardrails` sensor; the
  first `verify` after merge re-runs the full set.
