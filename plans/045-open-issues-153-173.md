# 045 — Open issue slices: 153–173

Status: done (2026-11-19). Owner: maintainer. All OI-153..OI-173 rows done with evidence; slices landed via #178, follow-ups in 047/048/049.

This plan records the smallest honest slice for each open issue after #159 and
#174 landed on `main`. Several issues are epics (DuckDB, Parquet, workspaces)
and are deliberately split: the slice below lands a decision record, a typed
contract, and a tested code path; the native/UI follow-ups stay owner-gated and
are named rather than silently claimed as done.

Task IDs are stable. A row is `done` only with the evidence recorded here.

| ID     | Issue | Status          | Slice                                                                                                                        | Evidence                                                                                                                                                |
| ------ | ----- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OI-153 | #153  | done            | ADR 0013: libSQL is the operational source of truth; analytics is read-only and out of the request path                      | `docs/decisions/0013-analytical-storage-boundary.md`                                                                                                    |
| OI-154 | #154  | done            | Reproducible benchmark plan, baseline harness, and a measured DuckDB comparison against the pre-set gate                     | `plans/046-analytics-benchmark.md`, `scripts/bench/analytics-bench.ts`                                                                                  |
| OI-155 | #155  | done            | Versioned, deterministic snapshot schema with manifest/checksum and atomic write (JSON interchange; Parquet writer deferred) | `packages/contracts/src/snapshot.ts`, `scripts/snapshot.ts`, `scripts/test/snapshot.test.ts`                                                            |
| OI-156 | #156  | done (decision) | DuckDB adopted for optional offline analytics only; no root or request-path dependency, adapter still unbuilt                | `plans/046-analytics-benchmark.md`, ADR 0013                                                                                                            |
| OI-157 | #157  | done            | Deterministic offline reports over existing eval artifacts (JSON + Markdown)                                                 | `scripts/reports.ts`, `scripts/test/reports.test.ts`                                                                                                    |
| OI-158 | #158  | done            | Concurrency receipt proving per-run source callbacks do not leak across runs/tenants                                         | `packages/server/test/runtime-concurrency.test.ts`                                                                                                      |
| OI-160 | #160  | done            | Claim/evidence assessment contract, server module, and an `AnswerHttpResponse.claimAssessment` receipt                       | `packages/contracts/src/claims.ts`, `packages/server/src/claims.ts`, `packages/server/test/runtime-claims.test.ts`                                      |
| OI-161 | #161  | done            | OIDC production audit: verifier semantics, claim mapping, deployment checklist                                               | `docs/oidc-production-audit.md`                                                                                                                         |
| OI-162 | #162  | done            | Hardened reverse-proxy profile checked by a config test (existing Caddy profile audited)                                     | `scripts/test/proxy-profile.test.ts`                                                                                                                    |
| OI-163 | #163  | done            | Multi-stage container: dependency/build and minimal runtime stages                                                           | `Dockerfile`, `scripts/test/dockerfile.test.ts`                                                                                                         |
| OI-164 | #164  | done            | SBOM generation with digests + least-privilege CI artifact step                                                              | `scripts/sbom.ts`, `scripts/test/sbom.test.ts`, `.github/workflows/sbom.yml`                                                                            |
| OI-165 | #165  | done            | Cross-platform smoke: macOS fast check, Windows build+check:fast                                                             | `.github/workflows/ci.yml`                                                                                                                              |
| OI-166 | #166  | done            | MCP protocol audit: revisions not claimed without conformance; conformance matrix documented                                 | `docs/mcp-protocol-audit.md`, `packages/server/test/mcp.test.ts`                                                                                        |
| OI-167 | #167  | done            | One Node support policy (>=24, CI 24/26) with a machine check                                                                | `package.json`, `scripts/version-policy.ts`, `scripts/test/version-policy.test.ts`                                                                      |
| OI-168 | #168  | done            | Tenant/owner-scoped collections schema, repository, authenticated HTTP routes, and a served console page                     | `migrations/0014_collections.sql`, `packages/storage/src/collections.ts`, `packages/server/src/workspaces.ts`, `packages/server/src/workspaces-page.ts` |
| OI-169 | #169  | done            | Deterministic side-by-side comparison module, `POST /api/compare`, and console rendering                                     | `packages/server/src/compare.ts`, `packages/server/src/workspaces.ts`, `packages/server/test/compare.test.ts`                                           |
| OI-170 | #170  | done            | Deterministic JSON/Markdown/HTML/BibTeX report exports with atomic write refusal                                             | `packages/contracts/src/report.ts`, `scripts/export-report.ts`, tests                                                                                   |
| OI-171 | #171  | done            | Typed provider registry with dated provenance and separate configured/permitted/health status                                | `packages/contracts/src/providers.ts`, `scripts/provider-status.ts`, tests                                                                              |
| OI-172 | #172  | done            | Threat model + ADR: import policy is not isolation; third-party execution stays gated                                        | `docs/decisions/0014-plugin-isolation-boundary.md`, `docs/plugin-isolation.md`                                                                          |
| OI-173 | #173  | done            | Skill coverage matrix and one genuinely missing skill (dependency freshness)                                                 | `.agents/SKILLS.md`, `.agents/skills/dependency-freshness/SKILL.md`                                                                                     |

## Deliberate deferrals

- **Parquet writer (#155)**: the schema/manifest/checksum contract is landed and
  tested with JSON interchange. A Parquet native dependency remains a separate
  promotion decision; the DuckDB result does not imply Parquet adoption.
- **DuckDB adapter (#156)**: adopted as the isolated `@do-sift/analytics`
  package (plan 047). It is not a root dependency, not in shared contracts, and
  never in the request path.
- **Web UI (#168/#169/#170)**: a dependency-free console is served at
  `/workspaces`; it exports reports through `/api/reports/export`. A
  real-browser smoke test covers the console (plan 047).
- **Claim receipts and retention**: `claimAssessment` checks the stored
  answer's citations against passages that still exist. Pruning a passage also
  changes the retrieval set and the cache key, so the reply is usually a fresh
  answer; the receipt is structural either way and never claims entailment.
- **Workflow additions** are limited to least-privilege, no-secret jobs.

## Evidence (2026-11-17)

- `npm run check:fast` — PASS (prettier, eslint, typecheck, policy, guardrails,
  skills, governance, links, deps).
- `npm run check` — PASS (all 12 steps, including tests, offline evals, build),
  re-run after the console, retention, and benchmark changes.
- `npm run signals -- verify --set verification` — verdict green.
- `npx vitest run packages/storage/test/collections.test.ts
packages/server/test/compare.test.ts packages/server/test/runtime-concurrency.test.ts
scripts/test/{snapshot,report,reports,claims,providers,sbom,version-policy,dockerfile,proxy-profile}.test.ts`
  — PASS.
- `npx tsx scripts/snapshot.ts …` — wrote 2 rows, sha256 recorded;
  `npx tsx scripts/reports.ts …` — 1 retrieval group, 1 provider;
  `npx tsx scripts/export-report.ts … --format markdown` — wrote 197 bytes;
  `npx tsx scripts/provider-status.ts …` — `wikipedia [search] available, health ok, price unknown`.
- `npx tsx scripts/bench/analytics-bench.ts --rows 100000` ×3 — query 316/230/315 ms,
  peak RSS 567/556/553 MB. `npx tsx scripts/bench/analytics-bench.ts --rows 10000` —
  identical 9 groups and aggregates to DuckDB within 1e-9 (win32/x64, Node 24.9.0).
- DuckDB spike (`.spikes/duckdb-bench`, `@duckdb/node-api` 1.4.1-r.5, not committed)
  `--rows 100000` ×3 — query 26/28/27 ms, peak RSS 91/91/90 MB, same 9 groups and
  aggregates. Gate: 11.7× faster, 0.16× RSS, equivalent results, prebuilt binaries
  for every CI OS/arch, no request-path dependency → adopt for optional offline analytics.
- `npx vitest run packages/storage/test/retention.test.ts apps/cli/test/cli.test.ts
packages/server/test/workspaces.test.ts` — PASS (archived-collection pruning opt-in,
  console page served only where configured).
- `npx tsx scripts/version-policy.ts` — PASS (floor >=24; CI 24, 26).

## Open risks / follow-ups

- The DuckDB gate ran on win32/x64 Node 24; the analytics CI matrix passed on
  Linux 24/26, macOS 24, and Windows 24, which is the cross-platform evidence.
- Parquet remains a separate decision; the DuckDB result does not cover it.
- Archived-collection pruning is opt-in and deletes notes with the collection;
  operators must still snapshot the database before `--confirm`.

## Risks

- The collections schema adds tenant-scoped tables; forward-only migration and
  backup guidance are documented in `docs/deployment.md`.
- Provider registry prices are only shown when a dated source exists; missing
  metadata renders as `unknown`, never as a free tier.
