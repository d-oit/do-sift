# .agents/SKILLS.md

> Skills index (TPL-02, maintained by hand — regenerate deliberately when
> skills change). Source of truth is each skill's `SKILL.md` frontmatter
> (`name` + `description`); this file is a map, not a copy of procedures.

| Skill                | When to use                                                                                                                           | Path                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| add-plugin           | Create a new do-sift plugin package with manifest, capabilities, policy tests, and security review note.                              | `.agents/skills/add-plugin/SKILL.md`           |
| dependency-freshness | Triage scheduled dependency advisories, choose patch/minor/major handling, and record an owned exception without weakening gates.     | `.agents/skills/dependency-freshness/SKILL.md` |
| dev-signals          | Run and interpret do-sift's dev-signal harness — sensors, signal sets, strikes, staleness — and record evidence before task handoffs. | `.agents/skills/dev-signals/SKILL.md`          |
| evaluate-retrieval   | Run and interpret fixed evaluation datasets for retrieval, citations, budgets, and cache safety; compare against baselines.           | `.agents/skills/evaluate-retrieval/SKILL.md`   |
| htn-planner          | Decompose a coding objective into ordered subtasks with preconditions before touching code.                                           | `.agents/skills/htn-planner/SKILL.md`          |
| implement-slice      | Implement exactly one numbered task from a plan file without broad refactoring.                                                       | `.agents/skills/implement-slice/SKILL.md`      |
| integrate-provider   | Integrate an external API behind an existing plugin adapter, including terms/quota verification and offline tests.                    | `.agents/skills/integrate-provider/SKILL.md`   |
| migrate-storage      | Change the database schema or indexes safely — forward migrations, compatibility, backup/restore notes.                               | `.agents/skills/migrate-storage/SKILL.md`      |
| prepare-release      | Assemble and verify a release candidate without publishing anything.                                                                  | `.agents/skills/prepare-release/SKILL.md`      |
| production-readiness | Review or implement production-safe single-owner service changes across lifecycle, egress, observability, and rollback.               | `.agents/skills/production-readiness/SKILL.md` |
| review-security      | Security-review a change set with attack-fixture evidence before merging.                                                             | `.agents/skills/review-security/SKILL.md`      |
| skill-distiller      | Distill a resolved problem or repeatedly firing sensor into an updated feedforward guide.                                             | `.agents/skills/skill-distiller/SKILL.md`      |
| spike-runner         | Run a throwaway de-risking spike for an uncertain third-party, API, or performance question.                                          | `.agents/skills/spike-runner/SKILL.md`         |

## Coverage matrix (issue #173)

Recurring work and the skill that owns it. This is a decision record: a new
skill is added only when no existing procedure can be extended without
creating a second source of truth.

| Task / risk                                          | Owner                                      | Decision                                                   |
| ---------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Add a plugin, manifest, capabilities                 | `add-plugin`                               | keep                                                       |
| Plan a compound change, slice vs spike               | `htn-planner`                              | keep                                                       |
| Implement one task ID                                | `implement-slice`                          | keep                                                       |
| Run/test sensors, strikes, staleness                 | `dev-signals`                              | keep                                                       |
| Retrieval/citation/budget evaluation                 | `evaluate-retrieval`                       | keep                                                       |
| Third-party search/model integration                 | `integrate-provider`                       | keep                                                       |
| Schema/index migration                               | `migrate-storage`                          | keep                                                       |
| Release candidate assembly                           | `prepare-release`                          | keep                                                       |
| Request lifecycle, egress, rollback                  | `production-readiness`                     | keep (also owns runtime concurrency/cancellation)          |
| Auth, fetching, rendering, budgets, tenant isolation | `review-security`                          | keep (also owns tenant-isolation audits)                   |
| Resolved problem → feedforward guide                 | `skill-distiller`                          | keep                                                       |
| Uncertain API/performance question                   | `spike-runner`                             | keep                                                       |
| Dependency triage and expired exceptions             | `dependency-freshness`                     | **created** — the scheduled scan names no triage procedure |
| Provider health freshness                            | `integrate-provider`                       | extend, no new skill                                       |
| Container hardening                                  | `prepare-release` + `production-readiness` | extend, no new skill                                       |
| Reproducibility/Parquet snapshots                    | `evaluate-retrieval` + `prepare-release`   | extend, no new skill                                       |
