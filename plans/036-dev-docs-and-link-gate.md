# 036 — Developer documentation, decision log, and a doc link gate (issue #121)

Status: done (2026-11-03), DOC-01…DOC-06 complete.

Issue #121 asked for four things: a `docs/architecture/` index, at least five
ADRs in `docs/decisions/`, a contributor tutorial validated by a new
contributor, and a link checker in `check:fast`. The fourth is a check we can
enforce; the third is a human process — see "Docs-01 (open)" below for what
this change could and could not do about it.

## Task rows

| ID     | Task                                                         | Status | Acceptance evidence                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DOC-01 | `docs/architecture/README.md` index linking design documents | done   | `docs/architecture/README.md` — component table, search/answer lifecycles, links to decisions; `docs/README.md` indexes every guide                                                                                                                                            |
| DOC-02 | Ten decision records in `docs/decisions/`                    | done   | `docs/decisions/README.md` + `0001`…`0010`, covering the capability-based kernel, libSQL storage, zero-LLM search, the evidence contract, single bounded synthesis, hybrid retrieval, the browser-ethics boundary, no-Python, the plugin lifecycle, and the dev-signal harness |
| DOC-03 | Contributor guide: add a mock search provider end to end     | done   | `docs/contributing-guide.md` — setup, manifest, source, round-trip test, host wiring, docs, handoff, common failures                                                                                                                                                           |
| DOC-04 | Link checker in `npm run check:fast`                         | done   | `scripts/docs/links.ts` (pure scanner) + `scripts/markdown-links.ts` (sensor); registered in `scripts/check.ts`, `scripts/dev-harness/sensors.ts`, `do-harness.toml`; `links` case in `scripts/dev-harness/stale.ts`                                                           |
| DOC-05 | Link checker tests                                           | done   | `scripts/docs/test/links.test.ts` — 19 cases over code-stripping, slugs, anchors, reference links, path resolution, escape refusal, and the finding types                                                                                                                      |
| DOC-06 | `INV-009` records doc link integrity                         | done   | `plans/invariants.json`; `scripts/policy.ts` validates that `scripts/markdown-links.ts` exists                                                                                                                                                                                 |

## Design notes

- **Offline and hermetic.** The checker never fetches. A relative link is a
  path problem; treating it as a network problem would make the gate flaky and
  would leak the documentation surface to third parties.
- **Code samples are data.** Fenced blocks and inline code spans are blanked
  before scanning, so a guide that _shows_ a broken link (this repository has
  several, deliberately) does not fail the gate.
- **Anchors follow GitHub.** Lowercase, strip punctuation, spaces to hyphens,
  duplicate headings suffixed `-1`, `-2` in order. Em dashes are dropped by
  the punctuation strip, which is why `Closing outcome — 2026-09-29` resolves
  as `closing-outcome--2026-09-29`.
- **Vacuous passes are failures.** Zero files, zero links, zero headings, or a
  documented index with no relative links each fail. `README.md`,
  `CONTRIBUTING.md`, `plans/README.md`, and the two new indexes are named so a
  matcher that silently stops matching is caught.
- **`docs/decisions/` restates `plans/adr/`.** The plans are working records
  with task IDs and evidence; the docs are the readable outcome. Each record
  names its long-form source so the two can be compared, and `plans/adr/`
  stays authoritative.

## Docs-01 (open): the "validated by a new contributor" clause

Issue #121's third acceptance criterion — "the contributor guide is validated
by a new contributor within one sprint" — is a human observation, not
something a sensor can establish. The guide is written to be walkable and
every command in it is an approved command that passes on this branch, but
the validation itself needs a person who did not write it. Recorded as an
open item; it does not block the documentation and tooling work.

## Evidence (2026-11-03)

Files added:

- `docs/README.md`, `docs/architecture/README.md`,
  `docs/contributing-guide.md`
- `docs/decisions/README.md`, `docs/decisions/0001`…`0010`
- `scripts/docs/links.ts`, `scripts/markdown-links.ts`,
  `scripts/docs/test/links.test.ts`

Files changed:

- `scripts/check.ts`, `scripts/dev-harness/sensors.ts`, `do-harness.toml`
  (the `links` sensor in all three, plus the set lists)
- `scripts/dev-harness/stale.ts` (a `links` input case)
- `scripts/dev-harness/test/{sensors,cli}.test.ts` (registry parity, count)
- `plans/invariants.json` (`INV-009`)
- `README.md`, `CONTRIBUTING.md`, `plans/README.md`, `llms.txt`,
  `.agents/skills/dev-signals/SKILL.md`

Commands run:

- `npx vitest run scripts/docs/test/links.test.ts` → 19 passed
- `npx vitest run scripts/dev-harness/test` → 81 passed
- `npx tsx scripts/markdown-links.ts` → `links: PASS (91 files, 86 links, 661 headings)`
- `npx tsx scripts/skills-check.ts` → `skills: PASS (12 skills validated)`
- `npm run check` → recorded in the branch's final evidence (`plans/036` runs
  once for the whole branch alongside plans 035/037/038/039)

## Risks

- The scanner is a hand-rolled Markdown reader. It handles ATX headings,
  inline links, reference definitions, fenced and inline code — the shapes
  this repository uses. Setext headings and HTML anchors are not resolved; if
  a document adopts either, the checker will report a false `missing-anchor`
  rather than silently pass, which is the safer failure.
- Anchors are validated against our slug rules, which track GitHub's. A
  renderer with different rules (some static site generators) could disagree;
  the gate is for this repository's browsing experience.
