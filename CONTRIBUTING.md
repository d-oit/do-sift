# Contributing to do-sift

Read `AGENTS.md` first: it sets the ground rules (no Python, untrusted content is
data, every task has an ID and evidence) and the approved commands.

## Local setup

```bash
npm install
npm run check:fast     # typecheck + fast tests during development
npm run check          # full gate before handing off
npm run eval:offline   # deterministic evals
```

To run the server locally, copy `.env.example` values into your shell (see the
comments in that file) and start it with `npx tsx apps/server/src/index.ts`.
Production configuration and the HTTP contract are in `docs/deployment.md` and
`docs/api.md`.

## Writing a plugin

Plugins are kernel-managed. Use `plugin-search-wikipedia` as the reference
implementation. A new plugin needs all of:

1. A `plugin.json` manifest that passes `packages/kernel/src/manifest.ts`.
   Declare every capability you use (`network`, `paid`, `browser`, `computer`)
   and list network hosts and secret names in `permissions`.
2. Only the capability-checked services the kernel passes in context. Plugins
   never receive raw `fs` or `net`.
3. Policy tests showing that undeclared hosts, secrets, and ungranted
   `paid`/`computer`/`browser` capabilities are refused.
4. A short security review note (see `docs/security-review-*.md` for examples).

`paid` and `computer` capabilities cannot activate without an explicit
`kernel.grant(pluginName, capability)` and stay disabled in CI. Do not grant
them in tests unless the test is about the grant itself.

The `add-plugin` skill covers the full checklist.

## Changes to protected files

Changes to `.github/workflows`, `scripts/policy.ts`, and
`plans/invariants.json` need an explicit maintainer decision. See the approval
boundaries in `AGENTS.md`.

## Pull requests

Record changed files, commands run, results, and open risks in the relevant
plan file under `plans/`. Keep one task per PR.

Before asking for review or merge, run the read-only harness checks (DHC-11):

```bash
do-harness pr ready        # merge state, CI checks, unresolved review threads
do-harness pr no-effect    # confirm the diff has an effective change
do-harness metrics pr      # PR-loop measures: pushes per green, reruns, waivers
```

When CI fails, `do-harness ci-explain <run-id>` maps each failure to a local
repro command. These tools only read state; they do not push, merge, or edit.
