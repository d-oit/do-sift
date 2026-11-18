# Plan 049 — report follow-ups (2026-11-18)

Closes the follow-ups named after plan 048 plus the offline collection export
named after RPT-07. Same boundaries: no network,
no model call, owner/tenant scoping on every read and write, and the stored
question stays private unless explicitly opted in.

| ID     | Task                                                                                   | Precondition                                                             |
| ------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| RPT-06 | Backfill evidence metadata for collection items attached before migration 0015         | Snapshot columns exist (0015); references stay owner-scoped              |
| RPT-07 | Offline `report answer` CLI command: stored claims and citations, any supported format | `answers.reportInput` from RPT-04; pure formatters in contracts          |
| RPT-08 | Console export of a stored answer by id                                                | `reportFor.fromAnswer` host wiring (RPT-04); console report helper (047) |
| RPT-09 | Offline `report collection` CLI command: snapshotted sources and opt-in notes          | Collection snapshot (RPT-05/RPT-06); shared formatter (RPT-07)           |

## Boundaries

- Backfill scans only `item_kind = 'evidence'` rows with a null `evidence_url`
  in the repository's own `(tenant, owner)` scope. Existing snapshots are
  never rewritten, and an id the corpus cannot resolve stays null.
- `report answer` copies claim text and citation ids verbatim. The request
  question is omitted unless `--include-question`, matching the HTTP route.
- `report collection` reads only the owner's collection in the CLI's tenant.
  Legacy references without a snapshot are omitted, and owner notes appear
  only with `--include-annotations`, matching the HTTP route's default.
- The console sends only an answer id; the server authenticates the owner and
  resolves the answer in that owner's tenant.
- One formatter dispatcher (`renderReport`) is shared by the HTTP route and
  the CLI so their bytes cannot drift.

## Acceptance

- `collections backfill --dry-run` writes nothing; a real run fills only the
  resolvable legacy references and reports scanned/updated/unresolved counts.
  Cross-owner and cross-tenant scopes see zero rows.
- `report answer` prints or writes JSON/Markdown/HTML/BibTeX, refuses to
  overwrite `--out`, and exits non-zero for unknown/foreign answers or an
  unsupported format.
- `report collection` does the same for a collection, emits only resolved
  evidence snapshots, and keeps collection notes out unless requested.
- The console downloads a stored answer's claims, citations, and sources; the
  stored question does not appear in the default Markdown.
- `npm run check` and `npm run signals -- verify --set verification` pass.

## Evidence (2026-11-18)

- `npx vitest run apps/cli/test/cli.test.ts packages/storage/test/collections.test.ts`
  — PASS (46 tests). CLI covers all four formats (Markdown, JSON, HTML,
  BibTeX), question privacy and opt-in, collection source snapshots, note
  opt-in, overwrite refusal, foreign owner, unsupported format, and
  dry-run/real backfill counts.
- `npx vitest run packages/server/test/reports-export.test.ts packages/server/test/workspaces-console.e2e.test.ts`
  — PASS (10 tests). Real Chromium downloads the stored answer report and
  confirms the claim, citation id, and source URL while the question stays out.
- `npx tsc -p tsconfig.json --noEmit` — PASS.
- `npm run check` — PASS (12 steps); `npm run signals -- verify --set verification`
  — green.
- Remote CI on PR #179: Windows and macOS check/analytics jobs pass. Linux check
  and analytics jobs plus the container job stop in `npm ci` before building:
  onnxruntime-node 1.21.0 returns 404 for both Linux release tarballs. The
  latest `main` run fails identically, so this is an external dependency
  outage, not this change. No workflow was modified; rerun after the binaries
  are reachable again.
