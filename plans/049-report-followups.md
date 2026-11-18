# Plan 049 — report follow-ups (2026-11-18)

Closes the three follow-ups named after plan 048. Same boundaries: no network,
no model call, owner/tenant scoping on every read and write, and the stored
question stays private unless explicitly opted in.

| ID     | Task                                                                                   | Precondition                                                             |
| ------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| RPT-06 | Backfill evidence metadata for collection items attached before migration 0015         | Snapshot columns exist (0015); references stay owner-scoped              |
| RPT-07 | Offline `report answer` CLI command: stored claims and citations, any supported format | `answers.reportInput` from RPT-04; pure formatters in contracts          |
| RPT-08 | Console export of a stored answer by id                                                | `reportFor.fromAnswer` host wiring (RPT-04); console report helper (047) |

## Boundaries

- Backfill scans only `item_kind = 'evidence'` rows with a null `evidence_url`
  in the repository's own `(tenant, owner)` scope. Existing snapshots are
  never rewritten, and an id the corpus cannot resolve stays null.
- `report answer` copies claim text and citation ids verbatim. The request
  question is omitted unless `--include-question`, matching the HTTP route.
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
- The console downloads a stored answer's claims, citations, and sources; the
  stored question does not appear in the default Markdown.
- `npm run check` and `npm run signals -- verify --set verification` pass.

## Evidence (2026-11-18)

- `npx vitest run apps/cli/test/cli.test.ts packages/storage/test/collections.test.ts`
  — PASS (44 tests). CLI covers all four formats (Markdown, JSON, HTML,
  BibTeX), question privacy and opt-in, overwrite refusal, foreign owner,
  unsupported format, and dry-run/real backfill counts.
- `npx vitest run packages/server/test/reports-export.test.ts packages/server/test/workspaces-console.e2e.test.ts`
  — PASS (10 tests). Real Chromium downloads the stored answer report and
  confirms the claim, citation id, and source URL while the question stays out.
- `npx tsc -p tsconfig.json --noEmit` — PASS.
- `npm run check` — PASS (12 steps); `npm run signals -- verify --set verification`
  — green.
