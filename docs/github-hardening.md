# GitHub hardening for do-sift

Adapted from `d-oit/rust-2026-template`'s `docs/github-hardening.md`
(analyzed 2026-10-13). This is **advisory guidance**: applying branch
rulesets, enabling features, or adding `CODEOWNERS` are repository-settings
actions owned by the maintainer (see "Approval boundaries" in `AGENTS.md` —
changing `.github/workflows` also needs explicit approval). Nothing in this
file is enforced by `scripts/policy.ts`; the enforced checks are the sensor
pipeline and CI.

## Why

Agent-facing governance files steer what automated contributors may do.
Tampering with them silently widens a change's authority: a modified
`AGENTS.md` claims new "approved commands", a modified `plans/invariants.json`
drops a check, a modified workflow exfiltrates secrets. Protect them the way
production code protects its deploy keys.

## Sensitive paths

| Path                            | Why it is sensitive                                                   |
| ------------------------------- | --------------------------------------------------------------------- |
| `AGENTS.md`                     | Canonical agent contract (approved commands, boundaries)              |
| `plans/invariants.json`         | Machine-checked invariants (`scripts/policy.ts` maps them)            |
| `plans/adr/`                    | Accepted decisions are immutable                                      |
| `scripts/policy.ts`             | The policy sensor itself — weakening it weakens every gate            |
| `.github/workflows/`            | CI runs with credentials; org policy requires full-length SHA pinning |
| `do-harness.toml`, `.githooks/` | Sensor argv and hook entrypoints                                      |
| `.agents/skills/`               | Feedforward guidance; changes steer future agent behavior             |

## Recommended protections (owner actions)

1. **CODEOWNERS** — require review from a maintainer for the paths above,
   e.g. `AGENTS.md @d-oit`, `plans/invariants.json @d-oit`,
   `.github/workflows/ @d-oit`. Unreviewed agent PRs must not merge these.
2. **Branch ruleset on `main`** — the repo already requires `check (linux)`
   with strict required-status policy; keep it. Add "require review from
   Code Owners" for the sensitive paths and disallow force-pushes.
3. **Pin every action by full commit SHA** with a `# vX.Y.Z` comment
   (already the repo convention — see `plans/016` for what floating tags
   cost).
4. **Fork PRs must not receive secrets** — keep workflows on
   `pull_request` (not `pull_request_target`) unless a checkout of
   untrusted code is unavoidable and reviewed.
5. **Dependency automation** — Dependabot PRs get the same scrutiny as
   agent PRs; group bumps, pin the merge policy, never auto-merge a
   runtime dependency.

## What stays out of scope

- Stealth, fingerprinting, or CAPTCHA-adjacent anything (ADR 0005).
- Automated merging of agent-authored changes to the paths above without
  human review.
- Storing credentials in the repo, workflows, or `plans/` (integrate-provider
  rule: no keys in repo).
