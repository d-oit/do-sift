# Plan 053 — Dependency review round 2 (2026-11-21)

Status: review done (2026-11-21). Owner: maintainer.

Follow-up to plan 044. Scope is assessment only: no range edits, no
lockfile churn, no upgrades. Every candidate below is deferred with a
reason; the tree stays exactly as merged.

## Findings (2026-11-21, on main past #187)

- `npm audit`: **0 vulnerabilities.** The minimatch cluster stays resolved
  after the R-20 override removal (#185).
- `npm outdated --depth=0`: every direct dependency is at its wanted
  version. Six packages report a newer `latest` outside the pinned range:

| Package               | Current (wanted) | Latest    | Disposition                                                                                                                                                       |
| --------------------- | ---------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@duckdb/node-api`    | 1.4.1-r.5        | 2.0.1-r.1 | Defer: major bump of a native binding; needs a 046-style gate (prebuilt binaries for the full OS/Node matrix, identical aggregates, RSS bound) before any attempt |
| `@types/node`         | 24.19.2          | 26.6.6    | Defer: major; needs a spike against the TS 6 backend and the Node 24 floor before any attempt                                                                     |
| `typescript`          | 6.0.3            | 7.0.2     | Defer: still blocked per 044 (typescript-eslint peer range; 7.x backend maturity)                                                                                 |
| `vitest`              | 5.1.0            | 5.1.1     | Defer: vitest is pinned per DRV-04; patch moves only by decision, not by drift                                                                                    |
| `@vitest/coverage-v8` | 5.1.0            | 5.1.1     | Defer: moves with the vitest pin                                                                                                                                  |
| `playwright`          | 1.65.0           | 1.65.1    | Defer: patch, but the honest BRW-04 e2e is the gate; batch with the next e2e-touching change rather than churning the lockfile alone                              |

## Task IDs

| ID     | Task                                                        | Status |
| ------ | ----------------------------------------------------------- | ------ |
| DEP-09 | Round-2 assessment: audit + outdated, dispositions recorded | done   |

## Evidence

- `npm audit --json`: 0 vulnerabilities across all severities.
- `npm outdated --depth=0 --json`: table above; nothing installed is behind its wanted range.
- No `package.json` / `package-lock.json` changes in this slice.
