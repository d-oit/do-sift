# 0010 — Checks run as receipt-producing sensors

Status: accepted (first recorded 2026-09-13 in `plans/adr/0007-dev-signal-harness.md`)

## Context

"Tests pass" in a chat message is not evidence. A reviewer cannot tell which
command ran, against which files, at which commit, or whether a step was
skipped. Development discipline decays when it depends on self-reporting.

## Decision

The check pipeline is a **registry of named sensors** — format, lint,
typecheck, policy, skills, governance, links, deps, tests, evals, build — grouped
into signal sets:

- `feedback` — the edit loop.
- `verification` — before claiming a task done.
- `release` — release gating.

Each run produces a result receipt with exit code, duration, and an output
hash. A signal set that resolves to zero sensors is a **usage error, never a
vacuous pass**. The same registry drives `npm run check`, the dev-signal CLI,
and the upstream `do-harness` configuration, and a test asserts the three stay
in step.

## Consequences

- A task is done when a sensor exits 0, not when an agent says so. Task rows in
  `plans/` record the commands and their results.
- A sensor that fails three consecutive runs is halted until the cause is
  fixed, so a flaky check cannot be retried into passing.
- Adding a check means editing the registry, its tests, and `do-harness.toml`;
  the parity test makes a partial change fail rather than silently diverge.
- Cost: more machinery than `&&`-chaining scripts, and a new check is a
  multi-file change. The payoff is that every claim of "green" is a receipt.
