# Plan 075 — CI failure triage and install parity (#181, #183)

Status: in review. Owner: maintainer.

Closes the remaining implementable-without-workflow-changes slices of the
open CI issues: the failure taxonomy and advisory classifier for #183, and
the install-parity regression guard for #181. Workflow-level adoption
(structured failure summaries emitted from `.github/workflows/*`) stays an
owner-gated follow-up: editing workflows requires explicit approval under
AGENTS.md, so this slice ships the policy, the taxonomy, and a tested
classifier that a workflow can call once approved.

## Task IDs

| ID    | Task                                                                                                                                                                                | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FD-01 | Advisory failure classifier (`scripts/ci-diagnostics.ts`): six-category taxonomy, deterministic rules                                                                               | done   |
| FD-02 | Triage policy doc: taxonomy, bounded-retry rule, sanitization, ownership and audit procedure                                                                                        | done   |
| IP-01 | Install-parity guard in the `deps` sensor: every Dockerfile stage running `npm ci`/`npm install` must receive `.npmrc` (regression guard for the PR #179 onnxruntime failure class) | done   |

## Decision notes

- The classifier is keyword-based and exported as a pure function; every
  result carries `advisory: true` so a workflow can never present it as an
  authoritative verdict. Red-first: `scripts/test/ci-diagnostics.test.ts`
  and `scripts/test/install-parity.test.ts` failed against the stashed
  sources (missing exports) and passed after the implementation.
- The parity guard lives in the existing `deps` sensor instead of a new
  check step: no sensor-registry or `check.ts` surgery is needed for the
  guard to run in every CI job that already runs `npm run check`.
- Known limits, recorded rather than hidden: line-based Dockerfile parsing
  (no heredoc semantics), and classification needs a sanitized error
  excerpt — an empty log yields `unknown`, which is the honest result.

## Evidence

- `npx vitest run scripts/test/ci-diagnostics.test.ts scripts/test/install-parity.test.ts scripts/test/deps-check.test.ts` — 25/25 pass.
- `npm run check` (full gate: lint, typecheck, policy, guardrails, skills,
  governance, links, deps, tests, evals, build) — PASS after the change;
  the only pre-change failures were the new red tests themselves.
- The real `Dockerfile` passes the parity guard (both npm stages COPY
  `.npmrc` before installing).
