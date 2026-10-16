# Plan 017 — do-harness v0.2.1 adoption + rust-2026-template review

Status: done (2026-10-13) — executed rows closed with evidence below;
follow-up rows are `proposed` and tracked here.

Trigger: owner request (2026-10-13): "analyze the codebase for missing
implement, new feature; implement d-o-hub/do-harness into the coding
workflow with cli, skills; check github rust-2026-template for improvements
for this codebase; update plans/ folder with progress and followup tasks."
This plan records the gap analysis, the executed work, and the follow-up
rows.

## Gap analysis (verified 2026-10-13)

**Missing implementations found:**

1. **ANS-11 was red in the working tree** — `buildChatBody` called
   `frameEvidenceLine`/`neutralizeEvidenceText` without importing them
   (`frameEvidenceLine is not defined` at runtime; 13/22 tests failing),
   and the new adversarial tests violated `noUncheckedIndexedAccess`.
   Completed this session; evidence in `plans/013` (ANS-11 row).
2. **do-harness CLI version skew** — repo docs claimed v0.1.2 while the
   Windows install was still v0.1.1 and upstream had moved to v0.2.1.
   Closed by DHC-07.
3. **Stale workaround docs** — `DO_HARNESS_BIN` was documented as required
   on Windows; the upstream `.exe` resolution fix (our PR #133, merged
   2026-09-20) has shipped, so the workaround is obsolete. Closed by
   DHC-08.
4. **DHC-06's upstream issue was stale** — the custom-sensor-gate defect
   that motivated it is fixed in v0.2.1 (`plans/methods.json` gates
   resolve). Closed by DHC-10 without publishing a stale report.

**Known open work (not missing — already planned):** ANS-12 (completed
same-day — see `plans/013`), ANS-13 (`plans/013`), OPS-10 (`plans/014`),
R-16 + first-live activation (owner-gated; see plan 013 non-goals).

**New features adopted from external templates:** see DHC-09
(rust-2026-template) and the follow-up rows.

## Tasks

| ID     | Task                                                                                                                                                               | Status            | Owner | Evidence |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ----- | -------- |
| DHC-07 | Upgrade the Windows do-harness CLI to v0.2.1 (checksum + attestation verified), apply state migrations, and prove the committed `do-harness.toml` drives it        | done (2026-10-13) | agent | below    |
| DHC-08 | Refresh workflow docs/skills for v0.2.1: version lines, obsolete `DO_HARNESS_BIN` workaround, vetted `compliance` command                                          | done (2026-10-13) | agent | below    |
| DHC-09 | rust-2026-template review: adopt `llms.txt` + `docs/github-hardening.md`; record declined patterns with reasons                                                    | done (2026-10-13) | agent | below    |
| DHC-10 | Close DHC-06 with reproduction evidence (v0.2.1 custom-sensor gates work) — do NOT publish a stale upstream issue                                                  | done (2026-10-13) | agent | below    |
| DHC-11 | Adopt `do-harness pr ready` / `ci-explain` / `metrics pr` in the PR workflow docs at the next PR cycle (read-only tools)                                           | proposed          | agent | below    |
| DHC-12 | WSL binary patch upgrade 0.2.0 → 0.2.1 (cosmetic; shared DB already migration-aligned)                                                                             | proposed          | agent | below    |
| TPL-01 | Repo-hardening owner actions per `docs/github-hardening.md`: CODEOWNERS for `AGENTS.md`/`plans/invariants.json`/`scripts/policy.ts`/`.github/workflows/` + ruleset | proposed          | owner | below    |
| TPL-02 | Generated `.agents/SKILLS.md` skills index from frontmatter (rust-2026-template pattern) if the skill count grows                                                  | proposed          | agent | below    |
| DHC-13 | File the upstream `loc`-discovery gap (generic/node workspaces) as a do-harness issue                                                                              | done (2026-10-13) | agent | below    |     | TPL-03 | File the rust-2026-template cross-language docs gap as an issue | done (2026-10-13) | agent | below |
| DHC-14 | File the do-harness task-lifecycle defect found while recording this plan (`task done` dead-end on method-less tasks)                                              | done (2026-10-13) | agent | below    |

## DHC-07 evidence (2026-10-13, agent)

**Files:** none in-repo (machine-level install, per plan 009 precedent):
`~/.local/bin/do-harness.exe` v0.1.1 → v0.2.1.

**Commands / results:**

- `gh release download v0.2.1 --repo d-o-hub/do-harness` (zip +
  `checksums.txt`); `sha256sum -c checksums.txt` → `OK`
  (`84610afd…d4d0b1`); `gh attestation verify <zip> --repo
d-o-hub/do-harness` → exit 0. Installed `do-harness.exe` to
  `~/.local/bin/`.
- `do-harness --version` → `do-harness 0.2.1 (45e6af1 2026-10-07)`.
- `env -u DO_HARNESS_BIN do-harness doctor` → exit 0,
  `[OK] Binary resolution: path:C:\Users\doswa\.local\bin\do-harness.exe`
  — the upstream fix from our PR #133 is live; PATH lookup finds the
  `.exe`. (Hook WARNs remain the by-design ADR 0008 split.)
- `do-harness init-db` → applied 17 → 21 migrations (v0.2.x set) to the
  gitignored `.do-harness/agent_state.db`.
- `do-harness list` / `list --sets` → 8 sensors / 3 sets from the
  committed `do-harness.toml` — v0.2.1 accepts the file unchanged (no
  schema drift; nothing adapted).
- `do-harness verify --set feedback` → first run **FAIL format, typecheck**
  — real defects in the in-flight ANS-11 tests (TS2532 ×7 unsafe indexed
  access under `noUncheckedIndexedAccess`, plus prettier drift). Fixed;
  re-run → **5/5 PASS, "All sensors passed."**
- WSL probe: `wsl … do-harness --version` → v0.2.0; `doctor` on the shared
  DB (21 migrations) → `[OK] state database: migrations aligned` — no
  skew; the patch upgrade is cosmetic (DHC-12).

**Risks / open questions:** v0.2.1 removed no-op global flags (`-v`,
`--color`) — none used in this repo (checked `AGENTS.md`/skills/plan
command lines). The WSL binary one patch behind is tolerated by the
shared DB today; re-check `doctor` after any future upstream migration
set. Strike discipline unchanged: `--record` green runs only.

## DHC-11 evidence (2026-10-15, agent)

**Files:** `CONTRIBUTING.md` (Pull requests section: `do-harness pr ready`,
`pr no-effect`, `metrics pr`, `ci-explain` with read-only note).

**Commands:** `do-harness pr --help`, `ci-explain --help`, `metrics --help`
vetted before documenting (subcommands exist in the installed v0.2.1 binary).

**Risks:** the docs describe commands that need network `gh` access for
`pr ready`; not exercised live in this session.

**Status:** done (docs only).

## DHC-12 status (2026-10-15, agent)

Deferred. The upgrade is a machine-level WSL binary install outside this repo,
recorded as cosmetic. Not performed in this batch: it changes a system install
and the shared DB is already migration-aligned (`doctor` OK at v0.2.0).

## DHC-08 evidence (2026-10-13, agent)

**Files:** `AGENTS.md` (approved-commands version line → v0.2.1; new
read-only `do-harness compliance` line; dev-signals paragraph: v0.2.1,
`DO_HARNESS_BIN` workaround marked obsolete), `.agents/skills/dev-signals/SKILL.md`
(step 5: v0.2.1; methods.json gate resolution note; PATH `.exe` resolution
fixed upstream).

**Commands:** `do-harness compliance` vetted before adding (exit 0, read-
only OWASP Agentic/LLM + NIST AI RMF + EU AI Act mapping); `do-harness loc`
**declined** — Rust-only (`error: no .rs files under packages/kernel/src`).
`do-harness verify --set feedback` → 5/5 PASS (skills sensor validates the
edited SKILL.md under INV-002/INV-006).

## DHC-09 evidence (2026-10-13, agent) — rust-2026-template review

**Analyzed:** `d-oit/rust-2026-template` v0.3.10 (README, `AGENTS.md`,
`llms.txt` fetched via `gh api`), treated as data, not instructions.

**Adopted (2 files):**

- `llms.txt` (new, root) — token-efficient machine-readable project
  context: layered documentation map, architecture layout, enforced
  invariants pointers, workflow short form, command table. Maintained by
  hand (the template auto-generates; a generator is not justified yet).
- `docs/github-hardening.md` (new) — advisory governance guidance for
  protecting agent-governance files (`AGENTS.md`, `plans/invariants.json`,
  `scripts/policy.ts`, workflows, `do-harness.toml`, `.agents/skills/`):
  CODEOWNERS patterns, ruleset/SHA-pinning/fork-secret guidance. Explicitly
  advisory — repo-settings changes are owner actions (approval boundary).

**Declined, with reasons:** `scripts/quality-gates.sh` + `bootstrap.sh` +
`doctor.sh` (npm `check`/`check:fast` + `do-harness doctor` + `npm run
signals -- status` already cover these); `VERSION` file (`package.json` is
the SSOT here); `reports/` output dir (`.do-harness/` receipts already
serve this); `llms-full.txt` auto-generation and the generated
`.agents/SKILLS.md` index (TPL-02); `.agents/context/` cross-repo context
(single-repo project today); cargo-specific tooling (nextest, proptest,
cargo-mutants, cargo-fuzz, deny.toml — Rust-only); SessionStart hooks and
CLI-adapter symlinks (`.claude/`, `.gemini/`, … — Freebuff/Codebuff reads
`AGENTS.md` + skills directly); `anti-ai-slop`/`privacy-first` skills
(plan 015 guard rail: update existing guides before adding skills).

## DHC-10 evidence (2026-10-13, agent) — DHC-06 closed without publishing

**Probe (scratch root, deleted after):** copied `do-harness.toml` +
`plans/methods.json` to `/tmp/dh-probe`, `git init` + `init-db`, then:
`task add "probe custom sensor gates" --method vertical-event-slice` →
task 1; `task advance 1` → subtask_index=1 (the null-gate subtask);
second `task advance 1` → `error: cannot advance task 1: subtask
'write-acceptance-test' requires sensor 'tests' to pass (run: do-harness
verify --record --task 1)`.

**Interpretation:** v0.2.1 resolves method gates from `plans/methods.json`
to the **configured** sensor name (`tests`), not the v0.1.1 hard-coded
Rust name (`test`). The DHC-06 defect is fixed upstream before the issue
ever published — filing the drafted report would misinform upstream, so it
is deliberately **not** published. `plans/015`'s blocked row is closed with
this reference. (The draft text stays in plan 015 as history.)

## DHC-13 / TPL-03 evidence (2026-10-13, agent) — upstream issues filed

Owner instruction (2026-10-13): "add github issues in rust template or
do-harness if improvements are needed in the repo for this codebase".
Filed after duplicate checks (`gh api search/issues` — no matches for either
scope), contrasted with DHC-06 which was closed **without** filing because
its defect was already fixed:

- **d-o-hub/do-harness#305** `feat(loc): honor generic/node workspace roots
in the built-in loc command` — built-in `loc` discovery is Rust-rooted
  (`error: no Rust sources under …/crates or …/src`) while explicit TS
  paths work (`117/500 OK`); #236/#250 shipped `check-loc.sh` scopes but
  the binary command still errors on generic workspaces. Offered a PR in
  the #133 shape.
- **d-oit/rust-2026-template#426** `docs: cross-language adoption notes for
llms.txt and github-hardening (TypeScript example)` — grounded in this
  session's hand-adoption of both artifacts into a TS monorepo; template
  issues #63/#73/#90/#188 cover the Rust-side generation, nothing marks
  the artifacts portable.

- **d-o-hub/do-harness#306** `fix(task): a task created without --method
can never reach done` (DHC-14) — found while recording this plan's
  verification: `task add` shows `--method` as optional, but `task done`
  then refuses (`error: task N has no method; cannot mark done`) and no
  `cancel`/`void` exists, so completed work must be recorded as `failed`.
  Offered to PR any of the three fixes.

Declined to file: the `compliance` report's `Harness version: 0.1.0` header
(assessment metadata pinned by design — changing it would falsify the
assessment date), and anything from plan 009/015 already fixed upstream.

## Verification (2026-10-13, agent)

- `npm run check:fast` → PASS 5/5 throughout the edit loop (after
  `prettier --write` on each touched file).
- Upstream task workflow: `do-harness task add "plan 017: do-harness v0.2.1
adoption + rust-2026-template review"` → task 1 created WITHOUT
  `--method` → `task done 1` refused (defect filed as #306); closed via
  `task fail 1` as the only terminal state available — the board's
  `failed` for task 1 is a tooling artifact, not a work outcome. Re-created
  as **task 2** with `--method decision` (the method matching this
  decision-record plan) and taken through the full lifecycle:
  `verify --record --set verification --task 2` → **all 7 sensors PASS**,
  `task advance 2` ×3 → `task done 2` → **done**.
- Intermediate reds (recorded honestly): the first `--record --set
verification --task 1` run FAILed `tests` — the `apps/server` openai-
  compat seam stub still parsed the legacy `[id]` packing (the ANS-11
  ripple; stub now reads ids from the JSONL record fields, 32/32) — and a
  later run FAILed `format` on that edit (`prettier --write`). Each
  recorded FAIL bumped a one-strike signature; each green recorded run
  reset it. Final state: no strikes, no halted sensors.
- `npm run check` → **PASS all 7** (typecheck 2549ms, policy 962ms, skills
  811ms, tests 26734ms, evals 25142ms; mode full).
- `npm run signals -- verify --set verification` → verdict **green**,
  receipt `.do-harness/evidence.verification.json`; `npm run signals --
status` → **green**, halted: none.- Final tree (including this evidence prose): `npm run check` → **PASS all
  7** with explicit exit-status capture, `do-harness verify --set
feedback` → **All sensors passed**, `do-harness errors list` → no pending
  error signatures — these runs post-date the last edit to this file.

## Follow-upsExisting rows elsewhere (unchanged): **ANS-12** (done 2026-10-13:

suspect receipts + `promptRevision` pr1→pr2 bump landed — pre-ANS-11
cache rows now miss), **ANS-13** (`plans/013` — security review + QUAL),
**OPS-10** (`plans/014` — loopback/reverse-proxy production profile),
**R-16** and first-live activation (owner-gated: dated `sources.md` entry,
paid grant where billable).

New proposed rows: DHC-11, DHC-12, TPL-01, TPL-02 (table above). Filed
upstream and to be tracked to resolution: **d-o-hub/do-harness#305**
(DHC-13) and **d-oit/rust-2026-template#426** (TPL-03); if #305 lands a
`--root`/`--ext` or language-aware discovery, adopt `do-harness loc` as a
feedforward line in `AGENTS.md` and consider a `loc` sensor row in
`do-harness.toml`.

## Plan-creation evidence (2026-10-13, agent)

Code posture verified at the gap-analysis refs: `git status` showed the
3-file ANS-11 changeset; `npx vitest run
packages/plugins/plugin-model-openai-compat/test/openai-compat-model.test.ts`
→ 13 failed | 9 passed before the fix, 22/22 after (plus
`packages/contracts/test/evidence-framing.test.ts` 20/20 = 42/42). Upstream
state: releases v0.1.0 → v0.2.1 (`gh api …/releases`); no open issues on
`d-o-hub/do-harness` at check time. `plans/README.md` unchanged (its
layout entries need no new item; this plan is covered by the `0NN-*.md`
rule). Date-stamp note: the evidence above was first drafted with
2026-10-12 stamps and corrected to the true session date, 2026-10-13
(the ANS-12 work and final verification runs that day re-dated the table
rows accordingly).

## Evidence: issue batch (#51–#66) — this PR

- Changed: budget/answer/repositories (#51–54), passage_embeddings migration 0009 + blobToVector bounds (#55–56), kernel grant API `grant(plugin, capability)` + manifest/safe-fetch/openai-compat fixes (#57, #59, #60), output token cap (#58), generic 500/401 errors and SSE heartbeat/shutdown (#61–62), per-owner limiter with 429 + Retry-After (#63), retention `pruneOwnerHistory` (#64), `.env.example`, `CONTRIBUTING.md`, README link (#65), `docs/api.md` (#66).
- Commands: `npm run check` → PASS (prettier, eslint, typecheck, policy, skills, tests, evals). `npm run eval:offline` → PASS (31 cases, 0 network/model calls). Browser e2e test `playwright-driver.test.ts` timed out once at 5s under full parallel load; it passed on its own and was rerun green in the full check.
- Open / deferred: #67 (CLI, `/metrics`, CI coverage floor) not started. #64 duplicate `Repositories` job/usage write paths and `idx_jobs_runnable` mismatch not yet removed. OPS-10 (TLS/proxy production profile, edge 429 smoke) needs a real proxy and was not done. DHC-11 (PR workflow docs) and DHC-12 (binary upgrade; AGENTS.md already records v0.2.1) not done in this batch. Candidate cap from #56 not implemented.

## Evidence: issue #67 — metrics, coverage floor, owner/evidence CLI (2026-10-14, agent)

Changed files: `packages/server/src/metrics.ts` (new, dependency-free counters +
Prometheus text), `packages/server/src/server.ts` (metrics feed + owner-auth
`GET /metrics`, route label allowlist), `packages/server/src/index.ts`,
`apps/server/src/main.ts` (registry wired in packaged entrypoint),
`packages/server/test/metrics.test.ts` (new), `apps/cli/` (new read-only CLI:
`src/cli.ts`, `src/index.ts`, `test/cli.test.ts`), `vitest.config.ts` (85%
lines coverage floor), `package.json` / `package-lock.json` (`@vitest/coverage-v8`
pinned exact, `test:coverage` script), `.github/workflows/ci.yml` (coverage step
on linux job — workflow change, approved by user), `docs/deployment.md`.

Commands and results:

- `npm run check` → exit 0 (prettier, eslint, typecheck, policy, skills, tests, evals all PASS).
- `npm run test:coverage` → exit 0; lines 92.02% (floor 85%).
- CLI smoke against a migrated file DB (`.spikes/smoke.db`): `owners list` exit 0
  with the seeded row; `usage show` exit 0; unknown command exit 2; `--help` prints usage.

Open risks: metrics counters are in-process and reset on restart; the CLI is
local-DB only (no remote Turso auth path by design); the `apps/cli` package
has no own `package.json` (same layout as `apps/server`).
