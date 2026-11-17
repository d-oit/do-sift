# Plan 048 — report and analytics follow-ups (2026-11-17)

Extends plan 047's export and analytics slices with the three follow-ups it
named. Each task is a thinnest honest slice: no new network, no model call, no
widening of the stateless export contract's privacy defaults.

| ID     | Task                                                                                         | Precondition                                                                 |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ANL-01 | done — `analytics summarize` CLI command over eval-result JSON, reusing `@do-sift/analytics` | DuckDB stays confined to the analytics package; CLI loads it lazily          |
| RPT-04 | done — export claims from a stored answer (`answerId`) instead of sources alone              | Answer rows, request question, and cited passages already exist (MT-13/#160) |
| RPT-05 | done — store evidence metadata on collection items and export a collection report            | New expand-only migration; collection scope unchanged                        |

## Boundaries

- Stored-answer export is owner-scoped: the authenticated owner id and the
  request's own question are used, never a caller-supplied owner or tenant.
- A collection report uses the metadata snapshot stored at attach time. An
  evidence reference with no snapshot (attached before this migration) is
  omitted rather than re-fetched; nothing is invented.
- Claims and citations are copied verbatim from stored rows. No repair loop,
  no re-validation that could upgrade an unresolved claim.
- The question and owner notes stay private unless `includeQuestion` /
  `includeAnnotations` are explicitly set, exactly as before.
- Analytics results are offline file input only; no operational table is read
  and no second writer appears.

## Acceptance

- CLI prints one aggregate row per provider/dataset, with `n`, and rejects
  malformed files with a non-zero exit.
- `POST /api/reports/export` with `answerId` renders stored claims with their
  citations; with `collectionId` renders stored sources and optional notes;
  unknown ids are 404; exactly one of `report`/`answerId`/`collectionId` is
  required.
- Collection items gain `evidence_url`, `evidence_title`,
  `evidence_fetched_at`; attachment still accepts ids the corpus does not
  resolve (metadata stays null) so existing reference-only behavior is not
  broken.
- `npm run check` and `npm run signals -- verify --set verification` pass.

## Evidence (2026-11-17)

- `npx vitest run apps/cli/test/cli.test.ts` — PASS (30 tests; 3 new for
  `analytics summarize`: table output, JSON to a new file with overwrite
  refusal, malformed/missing input). The DuckDB import is dynamic.
- `npx vitest run packages/server/test/reports-export.test.ts` — PASS (9
  tests; stored answer claims+citations, collection sources+notes, ambiguous
  modes, unknown ids, 501 without `reportFor`).
- `npx vitest run packages/storage/test/repositories.test.ts` — PASS (14;
  `answers.reportInput` returns the request question, verbatim blocks
  including an unresolved flag, and cited-passage provenance; cross-owner is
  undefined).
- `npx vitest run packages/storage/test/collections.test.ts` — PASS (8;
  attachment snapshots url/title/fetchedAt for a resolvable document id and
  leaves an unresolvable reference without metadata).
- `npx vitest run packages/server/test/workspaces-console.e2e.test.ts` — PASS
  in real Chromium: attach evidence, add a note, download the collection
  report and find the source URL and note in it, then the stateless report.
- `npm run check` — PASS (12 steps); `npm run signals -- verify --set verification`
  — green.
- Migration `0015_collection_item_evidence_metadata.sql` is expand-only; no
  backfill and no re-fetch of old attachments.

## Open risks

- DuckDB stays a native dependency of the analytics workspace only; the CLI
  must keep the import dynamic so `owners list` and friends never load it.
- A collection's stored metadata can age: it is a snapshot of the source at
  attach time, not a live join. The report says "retrieved <fetchedAt>", which
  is the original retrieval time.
