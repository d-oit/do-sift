# Plan 015 — workflow guide and skill compaction

Status: in-progress (2026-09-24)

Trigger: the production review exposed a repeated workflow lesson: the upstream
`do-harness` task method assumes Rust sensor names, while do-sift uses generic
Node sensors. The local method catalog now maps those gates explicitly. This
plan compacts the durable workflow guidance without deleting historical plan
evidence.

## Tasks

| ID     | Task                                                                                                                                                                                | Status            | Owner | Evidence                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----- | ------------------------------------------------------------ |
| DHC-05 | Update AGENTS/dev-signals/HTN/implementation/security/distillation guides; add the focused production-readiness skill; add the local do-harness method catalog and plan index entry | done (2026-09-24) | agent | below                                                        |
| DHC-06 | Publish the upstream custom-sensor gate issue in `d-o-hub/do-harness` when the GitHub credential has issue-write permission                                                         | blocked           | agent | GitHub 403; body at `/tmp/opencode/do-harness-task-gates.md` |

## Guard rails

- Update existing guides before creating new skills.
- Do not delete a skill solely because two guides overlap; preserve distinct
  triggers and procedures.
- Keep historical plan evidence and stable task IDs; compact navigation and
  current-status sections rather than rewriting history.
- No edits to accepted ADRs, `scripts/policy.ts`, `plans/invariants.json`, or
  CI workflows.
- If a do-harness defect blocks work, preserve the exact command/output and
  report it upstream; never weaken a sensor to hide it.

## DHC-05 evidence — 2026-09-24

Files:

- `AGENTS.md` — documented `plans/methods.json`, numeric do-harness task IDs,
  task/trace commands, and v0.1.2.
- `plans/README.md` — added the method-catalog layout entry.
- `plans/methods.json` — mapped upstream task gates to do-sift's `tests`,
  `evals`, `skills`, and `policy` sensors.
- `plans/002-contracts-storage-security.md` — corrected the stale top-level
  status and marked the detailed evidence historical.
- `.agents/skills/dev-signals/SKILL.md` — documented task-scoped receipts and
  the local method mapping.
- `.agents/skills/htn-planner/SKILL.md` — required a real plan row, existing
  sensor names, one owner/outcome, and trace-backed advancement.
- `.agents/skills/implement-slice/SKILL.md` — added do-harness task/trace
  requirements.
- `.agents/skills/review-security/SKILL.md` — added production request,
  observability, and redaction checks.
- `.agents/skills/skill-distiller/SKILL.md` — added upstream-defect handling.
- `.agents/skills/production-readiness/SKILL.md` — new focused production
  guard rail and verification procedure.
- `plans/015-workflow-compaction.md` — task record.

Commands:

- `npm run check:fast` → initial Prettier failure on four changed Markdown
  files; after `npx prettier --write` → **5/5 passed**.
- `do-harness verify --record --set feedback --changed --strict --task 2` →
  **5/5 passed**.
- `do-harness verify --record --set verification --changed --strict --task 2` →
  **7/7 passed**.
- `do-harness task advance 2` → advanced through all five configured subtasks;
  `do-harness task done 2` → **done**.
- `do-harness verify --record --set verification --changed --strict --task 2` →
  **7/7 passed** after the final guide/skill edits.
- `npm run signals -- verify --set verification` → **7/7 green**;
  `npm run signals -- status` → **green**, no halted sensors.
- `do-harness trace add` recorded the formatting recovery in session
  `do-sift-2026-09-24-workflow`.

Risks/open questions:

- DHC-06 remains blocked: GitHub's installed `ghu_` integration token returns
  `403 Resource not accessible by integration` for issue creation. The issue
  body is preserved at `/tmp/opencode/do-harness-task-gates.md`; retry after
  granting issue-write scope.
- The local method catalog is a compatibility mapping, not a weakening of any
  sensor. It must stay synchronized with `do-harness.toml` sensor names.
- Historical plan evidence was retained; only current-status/index guidance was
  compacted.

Status: done.

## Upstream issue draft — publication blocked

**Title:** `task workflow: custom sensor names cannot satisfy vertical-event-slice gates`

**Summary:** Upstream `vertical-event-slice` hard-codes Rust sensor names
(`test`, `check`, `clippy`). A generic workspace using `tests`, `evals`, and
`skills` can pass verification but cannot advance the task.

**Reproduction:** configure those custom sensors; run
`do-harness task add "example" --method vertical-event-slice`; run
`do-harness verify --record --set verification --task 1`; then run
`do-harness task advance 1`. The command reports that `write-acceptance-test`
requires missing sensor `test`.

**Expected:** method gates use configured/custom sensor names or validate the
mismatch when the task is created. **Actual:** advancement is blocked despite
all configured sensors passing.

The full draft is preserved at `/tmp/opencode/do-harness-task-gates.md`; issue
creation returned `403 Resource not accessible by integration`.
