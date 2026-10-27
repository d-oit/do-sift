# plans/ — decision records, task plans, invariants

This folder is the project's memory. Agents and humans update it together.

## Layout

- `0NN-*.md` — numbered milestone plans with task tables (one row per task ID)
- `methods.json` — do-harness task-method catalog; subtask gates reference
  this repository's configured sensor names
- `invariants.json` — machine-checked invariants; each maps to an enforcing
  test or script (CI fails if an invariant has no enforcing check)
- `risks.md` — living risk register with owners and status
- `sources.md` — dated records of commercial limits, quotas, and terms
  (Turso tiers, search/model providers). Every provider activation gate
  requires a fresh entry here.
- `adr/` — architecture decision records (immutable once accepted)
- `templates/task.md` — task record format

## Current queue

- `013-ans-evidence-hardening.md` — done (2026-10-13, ANS-10 → ANS-13); live-model steering re-measure stays owner-gated.
- `014-production-usage.md` — done (OPS-07 through OPS-10); public-domain TLS and public-IP 403 smoke remain owner-side evidence.
- `015-workflow-compaction.md` — done; DHC-06 closed as resolved upstream (v0.2.1, see plan 017 DHC-10).
- `017-harness-v021-template-review.md` — done; follow-ups closed: DHC-11 done, TPL-02 done (2026-10-22 hand-maintained `.agents/SKILLS.md`), DHC-12 superseded (WSL absent, Windows install ahead); TPL-01 agent portion done 2026-10-27 (CODEOWNERS covers every documented sensitive path), ruleset review requirement stays owner; living docs now pin do-harness v0.3.5.
- `018-open-work-closeout.md` — done (2026-10-27); audited all plan rows + the issue tracker (0 open issues), adopted `do-harness loc` with v0.3.5, closed TPL-01's in-repo portion, reconciled stale records, and queued CLS-06 (ten files over the 500-line budget). Owner-gated rows re-verified, not started.
- `016-ci-codeql-remediation.md` — closed. The in-repo _advanced_ CodeQL strategy (CI-01, CI-02, CI-03) was superseded: `codeql.yml` and `security.yml` are both deleted (PRs #44, #46) and CodeQL **default setup** is enabled weekly as the repository's only scanning configuration, which cleared the `code_scanning` ruleset gate. `actions/checkout` and `actions/upload-artifact` are now pinned to v7.0.1 (#47, #48); `main` is green and no pull requests are open. The CI-01/02/03 rows and the merge-gate and `Actions: write` sections are historical — read the plan's "Closing outcome" for the current invariants before acting on them.

Older milestone plans remain as historical evidence. Their detailed task
records and stable IDs are retained; use this queue rather than stale
"next suggested task" notes to choose new work.

## Task lifecycle

`proposed` → `ready` → `in-progress` → `done` (or `blocked`).

A task moves to `done` only when its acceptance evidence is recorded in the
plan file: commands, outputs, and remaining risks. "Tests pass" without a
command record is not evidence.

## Rules

1. Plans are append-friendly: prefer new ADRs over editing accepted ones.
2. Every invariant must have an enforcing check; `scripts/policy.ts`
   validates this mapping.
3. Commercial facts (prices, quotas, terms) expire — record the checked date.
4. Task IDs are stable forever; never reuse or renumber them.
