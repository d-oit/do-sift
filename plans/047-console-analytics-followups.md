# 047 — Console, analytics, and export follow-ups

Status: done (2026-11-19). Owner: maintainer. FUP-01..FUP-03 done with evidence; landed via #178, extended by 048/049 (#179).

Follow-ups named by plan 045/046. Each row is `done` only with the evidence
recorded here.

## Task IDs

| ID | Slice | Preconditions |
| ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- || FUP-01 | done — isolated `@do-sift/analytics` DuckDB package + CI matrix (Linux 24/26, macOS 24, Windows 24) | Plan 046 gate passed; prebuilt bindings for the matrix exist (ADR 0013) |
| FUP-02 | done — authenticated report-export route using the existing pure formatters, and a console export control | FUP-01 independent; report contract `REPORT_SCHEMA_VERSION` stays authoritative |
| FUP-03 | done — real-browser smoke test of the workspaces console against a live server | Console page and collection routes from plan 045 |

## Boundaries

- The analytics package is offline-only: no server, contract, plugin, or app
  may import it, and it never appears in the request path.
- Report export is stateless formatting of caller-supplied data; it stores
  nothing and reads nothing. The question and owner annotations stay private
  unless the request explicitly opts in.
- The browser test uses the real Chromium already required by the Linux CI
  dependency job; it does not add a second browser stack.

## Evidence (2026-11-17)

- `npx vitest run packages/analytics/test/aggregate.test.ts` — PASS (4 tests:
  empty input, known aggregates, 2,000-row equivalence with plain JavaScript,
  malformed/duplicate rejection). `@duckdb/node-api` 1.4.1-r.5 is a dependency
  of `packages/analytics` only; no server/app imports it.
- `npx vitest run packages/server/test/reports-export.test.ts` — PASS (5 tests:
  markdown download, private fields off unless opted in, HTML escaping, schema
  and format rejection, auth/method).
- `npx vitest run packages/server/test/workspaces-console.e2e.test.ts` — PASS
  in real Chromium: token, load evidence, compare two documents, create a
  collection, add a note, download `report.md` containing both source URLs, no
  page errors.
- `npx vitest run packages/server/test/workspaces.test.ts` — PASS, including
  document-id comparison resolution.
- `npm run check` — PASS (12 steps). `npm run signals -- verify --set verification`
  — green.
- CI: all four `analytics` matrix jobs pass (Linux 24/26, macOS 24, Windows
  24), as do the Linux full-test jobs that run the browser smoke test. Codacy,
  CodeQL, container, SBOM, and both check matrices pass on the same commit.

## Open risks

- The report route formats caller-supplied JSON. It stores nothing and escapes
  HTML, but a caller can download arbitrary claim text they themselves typed;
  that is a formatting service, not a new evidence path.
- The browser test depends on the Linux CI Chromium install and on the
  `playwright` workspace dependency; `DO_SIFT_ALLOW_BROWSER_SKIP=1` is the only
  opt-out and is not set in CI.
- `@duckdb/node-api` ships no win32-arm64 binding; Windows arm64 is unsupported.
