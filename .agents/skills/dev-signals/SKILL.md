---
name: dev-signals
description: run and interpret do-sift's dev-signal harness — sensors, signal sets, strikes, staleness — and record evidence before task handoffs.
---

# dev-signals

Development checks run as recorded, receipt-producing signals (plan 008,
ADR 0007; staleness per plan 010): "task done" claims cite dev-signal
status, not unverified memory.

## Procedure

1. After edits, run `npm run signals -- verify --set feedback` for the fast
   edit/fix loop (format, lint, typecheck, policy, skills). Before claiming a
   task done or handing off, run the `verification` set (all 7 check pipeline
   sensors through evals). The `release` set adds the release sensor for
   release gating only. If the `format` sensor fails, run
   `npx prettier --write` on the files you changed and re-verify — fix
   forward, never hand off red. When using upstream `do-harness`, scope
   `--record` to the numeric task ID returned by `do-harness task add`; the
   stable plan ID is descriptive metadata, not the database key.
2. Read `npm run signals -- status`: each sensor is `green` (last recorded
   result passed and matches the current tree), `stale` (it passed, but the
   working tree changed since that receipt — rerun `verify` to refresh),
   `red` (failed/errored/halted), or `missing` (never run); halted sensors
   are listed separately. Exit code 0 only when everything is green — stale
   is not green.
3. Understand strikes: a sensor that fails or errors on 3 consecutive runs is
   halted — on later runs it is skipped and reported failed until its strikes
   are cleared. A passing run resets the streak.
4. Cite receipts: `.do-harness/events.jsonl` is the append-only, hash-chained
   event log; `.do-harness/evidence.<set>.json` is the per-run receipt
   (per-sensor status, exit code, duration, output hash/tail, workspace
   fingerprint). Reference it in task evidence instead of restating results
   from memory. Partial reruns: `npm run signals -- verify --only <sensor>`
   refreshes one sensor (it must belong to the chosen set).
5. The upstream Rust `do-harness` CLI (ADR 0008; `do-harness.toml`; v0.1.2,
   Windows and WSL) runs the same sensors: `do-harness verify --record --set
<feedback|verification> --task <ID>`, `status --set <set>`, `doctor`. Its
   state sits beside ours under `.do-harness/` (`agent_state.db`,
   `evidence-rust-*.json`); neither runner reads the other, and `npm run
signals` stays the enforced receipt path. This repository's
   `plans/methods.json` maps task gates to its configured sensor names. On
   Windows `DO_HARNESS_BIN` must point at the exe (upstream's PATH lookup
   misses `.exe`); record green runs only — a recorded FAIL bumps the
   3-strike signature.

## Rules

- Never clear a strike before fixing the cause: run
  `npm run signals -- errors clear --sensor <name>` only after the fix lands.
  Never weaken a sensor or edit its argv to make it pass.
- After `npm run hooks:install` (git config core.hooksPath .githooks),
  pre-commit runs the feedback set and pre-push runs the verification set; a
  red hook blocks the commit/push — fix the failure, do not bypass.
- A green status with stale sensors is a claim about the past, not the
  present: cite it only together with a rerun that covers the current tree.
