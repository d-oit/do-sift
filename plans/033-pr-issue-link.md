# 033 — Link the #127 branch to its issue (REL-01)

Status: done (2026-11-03). Release/PR hygiene, no product change.

## Goal

PR #132 opened from `freebuff/8ec19ff58fa2d0e0048464e2` with the untouched pull
request template: no Task ID, no evidence, and no reference to issue #127, so
merging it would have left #127 open. This session has no GitHub credentials
(`gh auth status` reports signed out; `cloud_git` only fetches, pulls and
pushes), so the link has to land in the repository itself as a closing keyword
in a commit message, which GitHub honours when the commit reaches the default
branch. The changelog also never recorded the #127 work, which is the natural
content change to carry that commit.

## Task table

| ID     | Task                                                              | Status |
| ------ | ----------------------------------------------------------------- | ------ |
| REL-01 | Land a `Closes #127` commit on the PR head and changelog the work | done   |

## Approach

- `CHANGELOG.md`: a new first bullet under `[0.1.0] — UNRELEASED` → `### Added`
  describing the degradation-honesty contract: the evidence-only model
  fallback, per-claim unresolved citations, the `degradationReason` receipts,
  the eight injected failure scenarios, the 1.0 score enforced by
  `npm run check`, and the dashboard history/coverage surface, with plan
  references. The file previously named only the guardrails work (#124).
- A single commit carries the changelog plus this plan, and its message ends
  with the closing keyword so GitHub links it to #127.

## Evidence

Commands run 2026-11-03 from the repo root:

- `npx prettier --write CHANGELOG.md plans/033-pr-issue-link.md plans/README.md`
  → exit 0.
- `npm run check` → exit 0, **9/9 PASS** (prettier, eslint, typecheck, policy,
  skills, governance, tests, evals, build); the changelog edit changes no code,
  and the suite still reports 8/8 scenarios at `degradationHonesty=1.000`.
- Commit message contains `Closes #127`; pushed to the PR branch. CI and the
  PR's mergeable state are verified against the new head and reported in the
  handoff rather than in this file, because they only exist after the push.

## Risks

- GitHub reads a closing keyword from a commit message when the commit reaches
  the default branch. **Squash-merging rewrites the message to the PR title and
  body**, which still hold the template, so the close is guaranteed only for a
  merge commit or a rebase merge; a squash merge needs the PR body updated (or
  the issue closed by hand).
- The changelog entry describes the whole #127 scope in one bullet; splitting
  it per PR would read better once the release notes are cut.
