# Plan 049 — report follow-ups (2026-11-18)

Closes the follow-ups named after plan 048 plus the offline collection export
named after RPT-07. Same boundaries: no network,
no model call, owner/tenant scoping on every read and write, and the stored
question stays private unless explicitly opted in.

| ID     | Task                                                                                   | Precondition                                                          |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| RPT-06 | Backfill evidence metadata for collection items attached before migration 0015         | Snapshot columns exist (0015); references stay owner-scoped           |
| RPT-07 | Offline `report answer` CLI command: stored claims and citations, any supported format | `answers.reportInput` from RPT-04; pure formatters in contracts       |     | RPT-08 | Console export of a stored answer by id | `reportFor.fromAnswer` host wiring (RPT-04); console report helper (047) |
| RPT-09 | Offline `report collection` CLI command: snapshotted sources and opt-in notes          | Collection snapshot (RPT-05/RPT-06); shared formatter (RPT-07)        |
| RPT-10 | Collection identity in reports: optional title/description through every formatter     | RPT-09; report schema v1 remains backward-compatible (optional field) |
| RPT-11 | Collection exports read every attachment; the detail view keeps its 100-item cap       | RPT-09; repository scope and snapshot rules unchanged                 |

## Boundaries

- Backfill scans only `item_kind = 'evidence'` rows with a null `evidence_url`
  in the repository's own `(tenant, owner)` scope. Existing snapshots are
  never rewritten, and an id the corpus cannot resolve stays null.
- `report answer` copies claim text and citation ids verbatim. The request
  question is omitted unless `--include-question`, matching the HTTP route.
- `report collection` reads only the owner's collection in the CLI's tenant.
  Legacy references without a snapshot are omitted, and owner notes appear
  only with `--include-annotations`, matching the HTTP route's default.
- A collection report carries an optional `collection: { title, description? }`
  identity. It is rendered in JSON, Markdown, and HTML; BibTeX remains
  source-only. The field is optional, so schema v1 readers keep working.
- Report assembly uses `allItems`, an owner/tenant-scoped read with no limit,
  so a collection larger than `COLLECTION_LIST_MAX` does not lose older
  attachments. The workspace detail view still uses the capped `items` read.
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
  evidence snapshots, keeps collection notes out unless requested, names the
  collection in JSON/Markdown/HTML, and exports every attachment even when the
  collection has more than 100 items.
- The console downloads a stored answer's claims, citations, and sources; the
  stored question does not appear in the default Markdown.
- `npm run check` and `npm run signals -- verify --set verification` pass.

## Evidence (2026-11-18)

- `npx vitest run apps/cli/test/cli.test.ts packages/storage/test/collections.test.ts`
  — PASS (48 tests). CLI covers all four formats (Markdown, JSON, HTML, BibTeX),
  question privacy and opt-in, collection source snapshots, note opt-in,
  collection identity, overwrite refusal, foreign owner, unsupported format,
  and dry-run/real backfill counts. RPT-11 adds a 105-item export and a storage
  test proving `items` stays capped while `allItems` returns all 101 rows.
- `npx vitest run scripts/test/report.test.ts packages/server/test/reports-export.test.ts apps/cli/test/cli.test.ts packages/server/test/workspaces-console.e2e.test.ts`
  — PASS (55 tests): escaped collection metadata in all formatters, bounded
  caller-supplied metadata, and stored collection identity.
- `npx tsc -p tsconfig.json --noEmit` — PASS.
- `npx vitest run packages/server/test/reports-export.test.ts packages/server/test/workspaces-console.e2e.test.ts`
  — PASS (10 tests). Real Chromium downloads the stored answer report and
  confirms the claim, citation id, and source URL while the question stays out.
- `npx tsc -p tsconfig.json --noEmit` — PASS.
- `npm run check` — PASS (12 steps, after RPT-10 and RPT-11);
  `npm run signals -- verify --set verification` — green.
- Full-suite runs exposed a pre-existing browser-teardown hang: the console
  e2e left keep-alive sockets open, so `server.close()` exceeded the 30s hook
  budget after Chromium closed. Teardown now drops idle connections and the
  two real-browser suites have a bounded 60s hook budget. No assertion or test
  was skipped; the same suites pass alone and in the full check.
- Remote CI on PR #179: Windows and macOS check/analytics jobs pass. Linux check
  and analytics jobs plus the container job stop in `npm ci` before building:
  onnxruntime-node 1.21.0 returns 404 for both Linux release tarballs. The
  latest `main` run fails identically, so this is an external dependency
  outage, not this change. No workflow was modified; rerun after the binaries
  are reachable again.
