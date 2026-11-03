# Docs

Documentation for people using, operating, and contributing to do-sift.

New here? Read [the architecture index](architecture/README.md) first, then
[the contributor guide](contributing-guide.md). Decisions live in
[decisions/](decisions/README.md).

## Guides

| Document                                                           | What it covers                                                       | Audience        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------- |
| [architecture/README.md](architecture/README.md)                   | How the pieces fit: kernel, plugins, storage, retrieval, answer path | everyone        |
| [contributing-guide.md](contributing-guide.md)                     | Add your first plugin, end to end, with the checks it must pass      | contributors    |
| [decisions/README.md](decisions/README.md)                         | Index of architecture decision records and why each was made         | everyone        |
| [api.md](api.md)                                                   | HTTP contract: routes, roles, paging, error shapes                   | integrators     |
| [deployment.md](deployment.md)                                     | Configuration, environment variables, operations, rollback           | operators       |
| [multi-tenant-auth.md](multi-tenant-auth.md)                       | Auth providers, tenants, roles, membership, isolation limits         | operators, auth |
| [guardrails.md](guardrails.md)                                     | The declared ethical guardrails and how to extend them               | contributors    |
| [quality-gate.md](quality-gate.md)                                 | The evaluation gate: datasets, thresholds, baselines                 | contributors    |
| [live-eval-runbook.md](live-eval-runbook.md)                       | Running the opt-in live model evaluation                             | operators       |
| [release.md](release.md)                                           | Assembling and verifying a release candidate                         | maintainers     |
| [upgrading.md](upgrading.md)                                       | Node version requirements and upgrade paths                          | operators       |
| [github-hardening.md](github-hardening.md)                         | Repository protections and what they protect                         | maintainers     |
| [outbound-transport-inventory.md](outbound-transport-inventory.md) | Every outbound call and the guard in front of it                     | security        |
| [security-review-2026-10-13.md](security-review-2026-10-13.md)     | Most recent security review                                          | security        |
| [security-review-2026-09-14.md](security-review-2026-09-14.md)     | First security review                                                | security        |

## Plans

Numbered milestone plans, the risk register, and the provider source log live
in the repository's [`plans/`](../plans/README.md) directory. Plans are working
records with task IDs and evidence; the documents here are the readable
outcome.
