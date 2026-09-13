---
name: dev-signals
description: run and interpret do-sift's dev-signal harness — sensors, signal sets, strikes — and record evidence before task handoffs.
---

# dev-signals

Development checks run as recorded, receipt-producing signals (plan 008,
ADR 0007): "task done" claims cite dev-signal status, not unverified memory.

## Procedure

1. After edits, run `npm run signals -- verify --set feedback` for the fast
   edit/fix loop (format, lint, typecheck, policy, skills). Before claiming a
   task done or handing off, run the `verification` set (all 7 check pipeline
   sensors through evals). The `release` set adds the release sensor for
   release gating only.
2. Read `npm run signals -- status`: each sensor is `green` (last recorded
   result passed), `red` (failed), or `missing` (never run); halted sensors
   are listed separately. Exit code 0 means all green.
3. Understand strikes: a sensor that fails or errors on 3 consecutive runs is
   halted — on later runs it is skipped and reported failed until its strikes
   are cleared. A passing run resets the streak.
4. Cite receipts: `.do-harness/events.jsonl` is the append-only, hash-chained
   event log; `.do-harness/evidence.<set>.json` is the per-run receipt
   (per-sensor status, exit code, duration, output hash/tail). Reference it in
   task evidence instead of restating results from memory.

## Rules

- Never clear a strike before fixing the cause: run
  `npm run signals -- errors clear --sensor <name>` only after the fix lands.
  Never weaken a sensor or edit its argv to make it pass.
- After `npm run hooks:install` (git config core.hooksPath .githooks),
  pre-commit runs the feedback set and pre-push runs the verification set; a
  red hook blocks the commit/push — fix the failure, do not bypass.
