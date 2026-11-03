# 032 — Merge main's guardrails policy into the #127 branch (MERGE-01)

Status: done (2026-11-03). Repo maintenance, no product change.

## Goal

The #127 branch was cut at `c7bae83` (#129) and never picked up #130
(guardrails policy-as-code) or #131 (degradation honesty suite). A PR from it
would have deleted 350 lines of `tests/security/guardrails.test.ts`, 291 lines
of `packages/contracts/src/guardrails.ts` and `docs/guardrails.md`, and its
plan numbering collided with main's. Merge `main` in, keep both sides, leave
the branch green and reviewable.

## Task table

| ID       | Task                                                         | Status |
| -------- | ------------------------------------------------------------ | ------ |
| MERGE-01 | Merge `main` into the #127 branch without losing either side | done   |

## Approach

- `git merge --no-commit --no-ff FETCH_HEAD` (`e58a3b8`) produced 14 conflicts:
  10 add/add (the degradation suite, runner, history, artifact and tests) and
  4 content (dashboard, evals entries, docs, plans queue).
- Before resolving, each add/add pair was diffed: every hunk ran **ours →
  theirs** as a _removal_ of this branch's newer work (`receiptReason`
  coverage, recency-weighted notes, the `evidence-failure` scenario, receipt
  tests). No main-only hunk existed, so the suite, runner, history, eval
  entries, dashboard and artifacts resolve to this branch's side.
- Main's guardrails work arrives as new files here: `guardrails.ts`,
  `guardrails.json`, `docs/guardrails.md`, `tests/security/guardrails.test.ts`
  and plan `019-guardrails-policy-as-code.md`, plus their edits to the kernel,
  harnesses and answer path that auto-merged.
- Plan numbering: main is canonical (`019` guardrails, `020`–`023`
  degradation). This branch's four duplicates — `019-degradation-honesty-suite`,
  `020-degradation-behavior`, `021-degradation-dashboard`,
  `022-degradation-history` — differed from main's copies only in the plan
  number, so they are dropped rather than duplicated. The unique
  `023-degradation-reason-coverage` plan is renumbered `031` so no number is
  reused, and `plans/README.md` is rebuilt as one queue.
- Generated artifacts (`evals/dashboard/index.html`, `latest.json`) were
  regenerated from the merged sources instead of hand-merged.

## Evidence

Commands run 2026-11-03 from the repo root:

- `git merge --no-commit --no-ff FETCH_HEAD` → exit 1, 14 conflicted files
  listed by `git diff --name-only --diff-filter=U`.
- `npm ci` → exit 0 (restored sandbox had no `node_modules`).
- `npm run evals:dashboard` → exit 0, dashboard regenerated for 17 runs.
- `npm run check` → exit 0, 9/9 PASS (prettier, eslint, typecheck, policy,
  skills, governance, tests 18.3s, evals, build).
- Post-merge tree contains main's guardrails test and engine; the degradation
  suite still registers eight scenarios.

## Risks

- The suite, runner and dashboard on this branch remain newer than main's, so
  the merge commit is one-sided for those files by design; a reviewer should
  read the conflict resolution as "ours supersedes" rather than a semantic
  three-way merge.
- `plans/019`–`023` now carry main's numbering; references that used this
  branch's offset numbering (only `plans/030`) were updated.
- Local artifacts now include main's recorded runs; the dashboard's run count
  is a mixture of both histories.
- The merge does not create a PR, and pushing the branch is not a review.
