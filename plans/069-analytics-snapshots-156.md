# Plan 069 — Analytics snapshot dataset reader for issue #156

Status: in-progress (slice, 2026-11-27). Owner: maintainer. Follows plan 052
(Parquet deferral stands) and plan 068.

Issue #156 proposes `packages/analytics/` modules including
`snapshots.ts` to read versioned datasets. Parquet I/O stays deferred
(plan 052 gate still fails, re-confirmed on #155 2026-11-27), so this
slice reads the JSON interchange datasets written by
`scripts/snapshot.ts` — the same schema, manifest, and checksum
semantics a future Parquet writer must preserve.

## Task IDs (htn-planner, ordered)

| ID    | Task                                                                                            | Preconditions               | Sensor  |
| ----- | ----------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| SN-01 | `readSnapshotDataset` in `packages/analytics/src/snapshots.ts`: validate + normalize, re-export | Plan row exists (this file) | `tests` |
| SN-02 | Wire `@do-sift/contracts` dep (workspace `*`, lockfile synced); gates + evidence here           | SN-01 green                 | `evals` |

Out of scope: Parquet reading (deferred per plan 052), new analytical
queries, CLI flags, request-path use. `packages/analytics` stays
offline-only and still never appears in the request path.

## Decision notes

- Method: vertical-event-slice. Pure deterministic function over
  already-parsed JSON; no filesystem or network I/O in the module.
- Validation delegates to the authoritative contract
  (`normalizeSnapshot`, `assertSnapshotCompatible`): unknown schema
  versions, row-count mismatches, and checksum mismatches throw
  `SnapshotContractError` — errors, never warnings. Empty datasets are
  refused (INV-006), mirroring the writer.
- Returned records are the canonical normalized order, so shuffled
  input yields identical downstream output; the manifest echoes
  verbatim.
- Dependency follows the monorepo convention (`"*"` workspace link,
  as in `packages/server`); root `node_modules/@do-sift/contracts`
  already symlinks the workspace. Lockfile `packages/analytics` entry
  synced by hand to match exactly what npm records for a workspace
  `*` dep (no new resolved entry — it is a link).

## Evidence

- Red: new `packages/analytics/test/snapshots.test.ts` failed before
  the module existed (import error, 0 tests ran).
- Green: `npx vitest run packages/analytics` — PASS 5 files, 33 tests
  (26 existing + 7 new).
- `npm run check:fast` — PASS 9/9 (prettier, eslint, typecheck,
  policy, guardrails, skills, governance, links, deps).
- review-security: no new trust boundary (pure validation over
  caller-supplied JSON; error strings carry counts/versions only, no
  record content beyond what `SnapshotContractError` already emits).
  Residual: Parquet reading stays deferred; `connection.ts` lifecycle
  and any further #156 queries are follow-ups.
