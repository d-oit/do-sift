# Plan 009 — do-harness as workflow CLI + agent skills (restructure)

Status: done (2026-09-13 — DHC-04 closed via WSL prebuilt install; see limits)

Goal: the owner asked for d-o-hub/do-harness to be implemented "as CLI with
agent skills into the coding workflow and not as separate typescript
package", then directed (2026-09-13): "use the rust cli do-harness with
agents skills and agents.md concept usage". Plan 008 / ADR 0007 had ported
the harness concepts first-party; this plan (a) relocates that
implementation from `packages/dev-harness` to `scripts/dev-harness` —
workflow tooling, not a package (behavioral interface unchanged; ADR 0007
stays immutable), (b) ports do-harness's methodology skills and its
engineering model into AGENTS.md, and (c) adopts the upstream **Rust CLI**
per ADR 0008 (owner instruction superseding ADR 0007's "never the binary"
consequence for the dev loop only).

Skills are adapted, not copied: upstream's libSQL/`plans/tasks.json`
persistence maps to `plans/0NN-*.md` task rows, its cargo sensors map to the
repo's npm-pipeline sensors, its `tests/spikes/` maps to a gitignored
`.spikes/` scratch dir. Upstream skills tied to its Rust internals
(`event-modeler`, `fail-closed-proxy`) and to workflows do-sift already
covers (`harness` → `dev-signals`, `pr-triage`, `skill-creator`) are not
ported. The Python-dependent upstream eval/distill path stays excluded
(AGENTS.md ground rule 1).

## Tasks

| ID     | Task                                                                                                          | Status | Owner | Evidence |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------ | ----- | -------- |
| DHC-01 | Relocate dev-harness CLI from `packages/` to `scripts/dev-harness/` (workflow tooling, not a package)         | done   | agent | below    |
| DHC-02 | Port do-harness methodology skills: `htn-planner`, `spike-runner`, `skill-distiller` (adapted to do-sift)     | done   | agent | below    |
| DHC-03 | AGENTS.md coding-logic section (feedforward / feedback / self-correction / steering loop) + full verification | done   | agent | below    |
| DHC-04 | Adopt upstream Rust `do-harness` CLI: ADR 0008 + `do-harness.toml` + binary install                           | done   | agent | below    |

## DHC-01 evidence (2026-09-13, agent)

**Files:** `scripts/dev-harness/` (moved: `cli.ts`, `index.ts`, `schemas.ts`,
`sensors.ts`, `store.ts`, `strike.ts`, `verify.ts`, `test/*.test.ts` via
`git mv` — history preserved), deleted `packages/dev-harness/{package.json,tsconfig.json}`,
root `package.json` (`signals`, `hooks:install` → `scripts/dev-harness/cli.ts`),
`tsconfig.build.json` (−dev-harness reference), `vitest.config.ts`
(+`scripts/**/test/**/*.test.ts`), `.githooks/pre-commit` + `.githooks/pre-push`
(entry path), `.gitignore` (+`.spikes/`), `package-lock.json` (workspace
pruned via `npm install`), `scripts/dev-harness/test/*.test.ts` (imports
`../src/index.js` → `../index.js`; `cli.test.ts` CLI_ENTRY path).

**Design:** sources resolve everything from `process.cwd()` (no
`import.meta.url`), so the move is location-neutral; root `tsconfig.json`
already includes `scripts/**/*.ts` (typecheck coverage unchanged); vitest
picks the moved tests up via the new include; hooks/npm scripts still run
from repo root. ADR 0007's packaging-location clause is superseded by this
plan (recorded, ADR left immutable).

**Commands:** `npx vitest run scripts/dev-harness` → 57/57 pass; 9 CLI-test
failures after the move were a stale `CLI_ENTRY` in `cli.test.ts` (old
package path) — fixed, re-run green; `npm run signals -- list` → exit 0,
8 sensors / 3 sets; `npm run check` → PASS all 7 steps.

## DHC-02 evidence (2026-09-13, agent)

**Files:** `.agents/skills/htn-planner/SKILL.md`,
`.agents/skills/spike-runner/SKILL.md`,
`.agents/skills/skill-distiller/SKILL.md` (new, adapted from upstream
methodology skills: HTN decomposition with sensor-gated advancement; spikes
as throwaway `.spikes/` experiments judged by exit codes; post-task
distillation / steering loop). Persistence maps to plan rows, sensors to the
`signals` sets; no libSQL, no Python, no LLM calls.

**Commands:** `npm run skills:check` (inside check:fast) → PASS, 11 skills
validated (8 → 11, INV-002/INV-006 rules enforced); prettier clean.

## DHC-03 evidence (2026-09-13, agent)

**Files:** `AGENTS.md` (new "Coding workflow (do-harness engineering model)"
section: feedforward → red/green → feedback → self-correction → steering
loop; two approved-command lines for the optional Rust harness; dev-signals
paragraph now records the CLI home `scripts/dev-harness/` and the ADR 0008
runner split).

**Commands:** `npm run check:fast` → PASS 5/5; `npm run signals -- verify
--set feedback` → verdict green, exit 0, receipt
`.do-harness/evidence.feedback.json` (format 5541ms, lint 5861ms,
typecheck 2460ms, policy 816ms, skills 712ms); `npm run check` → PASS all 7
(prettier 5466ms, eslint 5807ms, typecheck 2499ms, policy 824ms, skills
734ms, tests 18242ms, evals 896ms). No edits to `plans/invariants.json`,
`scripts/policy.ts`, or `.github/workflows`.

## DHC-04 evidence (2026-09-13, agent) — blocked, then resolved same day

**Files:** `plans/adr/0008-do-harness-rust-cli.md` (new, accepted: owner
instruction supersedes ADR 0007's no-binary consequence for the dev loop;
TS CLI stays the enforced hook/CI path; Python eval/distill path stays
excluded), root `do-harness.toml` (new: `language = "generic"`, 8 sensors as
direct node entrypoints mirroring `scripts/check.ts` argv, signal sets
mirroring the first-party registry).

**Blocker (machine-level, not repo-level):** `cargo install --git
https://github.com/d-o-hub/do-harness do-harness` (cargo 1.95.0, rustc
1.95.0 stable-msvc) fails at native deps: `link.exe` resolves to Git Bash
coreutils `/usr/bin/link` ("extra operand … Try 'link --help'"), and the
probe showed no MSVC `link.exe` under either Visual Studio dir (both `2022/`
install dirs are empty), no Windows SDK (`Windows Kits/10/Lib` missing), and
no clang/libclang anywhere — all three required by upstream's
`libsql → bindgen → clang-sys` chain (build log: `windows_x86_64_msvc`,
`bindgen`, `clang-sys`, `proc-macro2` build scripts fail to link). GNU
toolchain (`stable-x86_64-pc-windows-gnu`) is installed but cannot help:
bindgen still needs libclang. No prebuilt release binaries exist upstream
(releases API: none). Stopped per AGENTS.md stop condition "a native
dependency fails on a target platform"; no feature-patching of upstream
crates attempted.

**Remedy (owner decision, system-level installs):** install VS 2022 Build
Tools with the "Desktop development with C++" workload (provides MSVC
link.exe + Windows SDK) and LLVM/Clang (libclang for bindgen), then re-run
`cargo install --git https://github.com/d-o-hub/do-harness do-harness`.
`do-harness.toml` is already in place; once installed: `do-harness init` is
NOT to be run in this repo (it would scaffold over AGENTS.md /
plans/invariants.json — approval boundary) — the committed toml suffices;
then `do-harness verify --set feedback`, `do-harness doctor`, `do-harness
status`. If upstream drifts its toml schema, adapt `do-harness.toml` then.

**Risks / open questions:** upstream is `wip-do-not-use` — sensor/set
semantics may change under us (mitigated: enforced path is the first-party
TS CLI); two runners write the same gitignored `.do-harness/` dir
(`agent_state.db` vs `events.jsonl`/`evidence.<set>.json`) — verified
non-colliding file names; `when-changed` globs deliberately unused (always
run, deterministic); Rust-CLI approved-command lines in AGENTS.md describe
the steady state and will fail with "command not found" until the toolchain
remedy lands.

**Resolution (2026-09-13, owner provided the install path):** upstream
published release v0.1.0 minutes after the blocker was recorded. The
official installer (`scripts/install.sh`, reviewed before execution) ships
checksum-verified prebuilt binaries for FOUR targets only —
x86_64/aarch64 linux-musl and darwin; **no Windows target** — and its
platform detection refuses Windows. Installed instead inside **WSL Ubuntu**
with the owner's exact command (through `bash -s`, not `sh -s`: dash lacks
`pipefail`):

- `do-harness 0.1.0 (3e04dd2 2026-09-13)` at `/home/doit/.local/bin/do-harness`.
- `do-harness doctor` → passed (binary OK; hook warnings are the by-design
  ADR 0008 split; state DB created via `do-harness init-db` — 12 migrations,
  writes only the gitignored `.do-harness/agent_state.db`).
- `do-harness list` → all 8 sensors from the committed `do-harness.toml`;
  `explain --set feedback` → all 5 selected, "change filtering disabled".
- `do-harness verify --set feedback` → **format, lint, typecheck PASS**;
  policy + skills FAIL (esbuild TransformError: the repo's `node_modules`
  carries win32-x64 esbuild, unusable under Linux node); tests/evals are
  the same class. `verify --only format` → PASS ("All sensors passed").
- `seed` refused: upstream expects `plans/invariants.json` as a sequence of
  DecisionHeaders; ours is a map enforced by `scripts/policy.ts`.
  Deliberately NOT converted (approval boundary + would break our policy
  sensor). `status` reports `insufficient_coverage` until a full set runs
  under the Rust runner — upstream coverage semantics, documented.

**DHC-04 outcome: adopted, with honest platform limits.** The Rust CLI is
the agent-facing harness for registry/explain/doctor and the pure-JS sensor
subset (format/lint/typecheck) inside WSL; full-set verification and
tsx/vitest-based sensors remain the first-party TS CLI's job on Windows
(npm run signals). A native Windows build still needs the MSVC+LLVM remedy
above; a Linux-native checkout (npm install inside WSL) would light up all
sensors under the Rust runner but would split the dependency tree — not
done. AGENTS.md approved-command lines are now accurate for WSL sessions.

**README read-through (owner request, 2026-09-13) — corrections adopted:**
upstream `status` freshness requires beats persisted via `verify --record`
and/or an evidence artifact via `--evidence`; bare verifies (our earlier
runs) never populate it — hence `insufficient_coverage`. Confirmed live:
`verify --set feedback --only format --record` persisted a beat (visible in
`do-harness metrics`) and a subsequent pass reset the error signature.
Strike caveat recorded: `--record` on a FAILING sensor bumps its signature
toward the 3-strike halt, so failing sensors are deliberately never
`--record`-ed here. The README also confirms: no Windows prebuilt target
(four release assets); `init` leaves existing files untouched without
`--force` (our earlier caution was stronger than necessary, but the
committed-toml path also avoids the incompatible `seed` step); upstream
pre-commit runs `verify --fail-fast --only fmt --only loc` (repeatable
`--only`; our first-party hooks keep their own shape); `pr no-effect` /
`pr review` are read-only generic-git tools available for a future PR
workflow. Steering-loop note: the Rust runner's format FAIL caught
plan-file style drift the same hour the plan-009 evidence edits introduced
it — two runners, same sensors, working as ADR 0008 intended.

**Addendum — full-suite proof on a Linux-native checkout (2026-09-13,
agent):** the remainder noted above ("a Linux-native checkout would light
up all sensors under the Rust runner") is now executed. The exact working
tree (including `.git` and all uncommitted session changes) was copied to
`~/src/do-sift-wsl` inside the WSL ext4 filesystem — NOT a split of the
Windows dependency tree — with `node_modules`, `.do-harness`,
`.fastembed_cache`, `.spikes`, `dist`, and tsbuildinfo excluded. There:
Linux `npm install`, `do-harness init-db` (12 migrations), then
`do-harness verify --set verification` → **all 7 sensors PASS, "All
sensors passed.", exit 0** under the Rust CLI driving Linux-native
node_modules — including the tests and evals sensors that were
impossible from the mounted tree, and the evals stage ran with a fresh
ONNX model download on Linux (proving the fastembed path outside
Windows). Upstream `seed` still refuses our invariants shape (#74),
consistent with the WSL findings. The checkout stays as the standing
Linux verification environment; refresh = re-run the same tar copy +
`npm install` + `init-db` (commands recorded here). Windows-side tree and
its enforced first-party runner are untouched by this verification.
