# Plan 042 — Guardrails docs closeout (plans 039–041)

Status: done locally (2026-11-09); PR CI reported in the handoff. Docs only;
no code or check changes.

## Context

The 2026-11-09 maintenance review and plan 040 left three documentation
follow-ups after PRs #138 and #140 merged: no `CHANGELOG.md` entry for the
Rego export or the sync gate, no `plans/README.md` row for plan 039, and
`check:fast` comment lines that still omit the `guardrails` step.

## Tasks

| ID     | Task                                                                                               | Status |
| ------ | -------------------------------------------------------------------------------------------------- | ------ |
| DCL-01 | `CHANGELOG.md`: one bullet for the Rego export and two-way sync gate (#138, #140)                  | done   |
| DCL-02 | `plans/README.md`: plan 039 row; plans 040/041 marked merged (#140, 33f50b8)                       | done   |
| DCL-03 | `guardrails` in the `check:fast` comments of `README.md`, `llms.txt`, `docs/contributing-guide.md` | done   |
| DCL-04 | Verify: `npm run check:fast` (format, links), PR CI green                                          | done   |

## Decisions

- One CHANGELOG bullet placed after the existing “Ethical guardrails as code”
  entry, covering both PRs, as plan 033 did for #127.
- Plan 039 keeps its own wording; its index row summarizes it without edits to
  the plan file.

## Evidence (2026-11-09, base 33f50b8 = origin/main after #140)

- `npx prettier --write` on the touched Markdown → exit 0 (`llms.txt` has no
  Prettier parser and is outside the `prettier --check .` set).
- `npm run check:fast` → 8/8 PASS, including `links` (new plan references
  resolve) and `guardrails`.
- Pre-commit (feedback set) and pre-push (verification set) hooks run on
  commit and push.
