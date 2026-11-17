---
name: dependency-freshness
description: Triage scheduled dependency advisories, decide patch/minor/major handling, and record an owned exception without weakening the offline gates.
---

# dependency-freshness

Use when a scheduled advisory scan fails, Dependabot opens a grouped PR, or a
direct dependency is deprecated. The gate is severity **and** exploitability,
not raw advisory count.

1. Read `docs/dependency-maintenance.md` and the current
   `policies/dependency-exceptions.json`. Do not add an exception before
   checking whether the vulnerable path is reachable.
2. Run `npm run check:fast`. The `deps` step proves the lockfile is
   reproducible and in sync with every workspace manifest; a lockfile-only
   change that skips it is not verified.
3. For a patch/minor update, run the focused test for the affected package,
   then `npm run signals -- verify --set feedback`. Runtime, native bindings,
   migrations, policy, auth, and provider behaviour require the full
   `npm run check` plus `npm run build` — never auto-merge them.
4. For a major update, write a plan row first (`plans/`), state the compatibility
   risk, and keep the upgrade in its own change. Do not combine it with feature
   work.
5. If the finding is a false positive or upstream-blocked, add an exception
   with severity rationale, owner, and an expiry date no later than 90 days.
   A stale exception must fail review, not linger.
6. Record evidence in the plan row: command, result, and the advisory id.
   Regenerate `npm run sbom` when a release candidate's dependency set changed.

Never edit `scripts/deps-check.ts`, `scripts/policy.ts`, or an exception expiry
just to make the sensor pass. Fix the cause or document the accepted risk.
