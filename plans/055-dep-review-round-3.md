# Plan 055 — Dependency review round 3 (2026-11-22)

Status: review done (2026-11-22). Owner: maintainer.

Follow-up to plans 044 and 053. Scope is assessment only: no range edits, no
lockfile churn, no upgrades. Every candidate below is deferred with a
reason; the tree stays exactly as merged.

## Findings (2026-11-22, on main at d17fb4a past #190)

- `npm audit --json`: **0 vulnerabilities** across all severities (105 prod, 162 dev, 76 optional).
- `npm outdated --depth=0 --json`: every direct dependency is at its wanted
  version. Five packages report a newer `latest` outside the pinned range
  (down from six in round 2 — `playwright 1.65.1` landed via #189/plan 054):

| Package               | Current (wanted) | Latest    | Disposition                                                                                                                                                       |
| --------------------- | ---------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@duckdb/node-api`    | 1.4.1-r.5        | 2.0.1-r.1 | Defer: major bump of a native binding; needs a 046-style gate (prebuilt binaries for the full OS/Node matrix, identical aggregates, RSS bound) before any attempt |
| `@types/node`         | 24.19.2          | 26.6.6    | Defer: major; needs a spike against the TS 6 backend and the Node 24 floor before any attempt                                                                     |
| `typescript`          | 6.0.3            | 7.0.2     | Defer: still blocked per 044 (typescript-eslint peer range; 7.x backend maturity)                                                                                 |
| `vitest`              | 5.1.0            | 5.1.1     | Defer: vitest is pinned per DRV-04; patch moves only by decision, not by drift                                                                                    |
| `@vitest/coverage-v8` | 5.1.0            | 5.1.1     | Defer: moves with the vitest pin                                                                                                                                  |

- `npx tsx scripts/deps-check.ts`: `deps: PASS (316 resolved packages, 23 workspace manifests, 2 documented upstream blocks, 0 override(s))` — R-20 removal holds, no inert overrides.
- `npm list playwright`: `playwright@1.65.1` / `playwright-core@1.65.1` under `@do-sift/browser-driver`, matching plan 054.

## Task IDs

| ID     | Task                                                        | Status |
| ------ | ----------------------------------------------------------- | ------ |
| DEP-10 | Round-3 assessment: audit + outdated, dispositions recorded | done   |

## Evidence

- `npm audit --json`: 0 vulnerabilities across all severities.
- `npm outdated --depth=0 --json`: table above; nothing installed is behind its wanted range.
- `npx tsx scripts/deps-check.ts` → PASS (316 resolved, 23 manifests, 2 blocks, 0 overrides).
- No `package.json` / `package-lock.json` changes in this slice.
