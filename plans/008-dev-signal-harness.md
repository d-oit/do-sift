# Plan 008 — Dev signal harness (do-harness concepts, first-party port)

Status: done (2026-09-13)

Goal: port d-o-hub/do-harness's dev-signal concepts (sensors, signal sets,
strikes/halt, append-only event log, evidence receipts, git hooks) into this
repo's coding workflow as first-party TypeScript. Per ADR 0007: concept-only
adoption (Plan 000 D10), no Rust binary, no Python, no LLM calls. Built by an
agent swarm with an orchestrator (this plan records the owners).

## Swarm / ownership map

| Wave | Owner (agent)   | Tasks          | Exclusive writable scope                                                              |
| ---- | --------------- | -------------- | ------------------------------------------------------------------------------------- |
| 0    | orchestrator    | DSH-01         | plans/008, plans/adr/0007, root package.json scripts, .gitignore, tsconfig.build.json |
| 1    | agent-core      | DSH-02         | packages/dev-harness/** (except src/cli.ts, test/cli.test.ts)                         |
| 1    | agent-wire      | DSH-03, DSH-04 | .githooks/**, README.md, AGENTS.md, .agents/skills/dev-signals/**                     |
| 2    | agent-integrate | DSH-05         | packages/dev-harness/src/cli.ts, packages/dev-harness/test/cli.test.ts                |
| 3    | orchestrator    | DSH-06         | plans/008 evidence, hook activation, full repo checks                                 |

Rule: no owner edits outside its column; everything else read-only.

## Tasks

| ID     | Task                                                                                                                             | Status | Owner           | Evidence |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------- | -------- |
| DSH-01 | ADR 0007 + this plan (frozen interface, ownership map)                                                                           | done   | orchestrator    | below    |
| DSH-02 | Core: schemas, hash-chained JSONL event store, strike/halt, sensor registry + runner, signal sets, evidence artifact, unit tests | done   | agent-core      | below    |
| DSH-03 | Version-controlled git hooks (.githooks/pre-commit, pre-push)                                                                    | done   | agent-wire      | below    |
| DSH-04 | Docs + skill: README section, AGENTS.md commands, .agents/skills/dev-signals/SKILL.md                                            | done   | agent-wire      | below    |
| DSH-05 | CLI (`init`/`verify`/`status`/`list`/`errors`/`hook`) + CLI tests                                                                | done   | agent-integrate | below    |
| DSH-06 | End-to-end verification (npm run check, eval:offline, hook dry-run, hook install) + evidence recording                           | done   | orchestrator    | below    |

## Frozen interface (agent-core implements; agent-integrate consumes; do not drift)

Package: `packages/dev-harness` — `@do-sift/dev-harness`, private, type
module, `exports: { ".": "./src/index.ts" }`, deps: `zod ^3.24.0`.
tsconfig identical to `packages/contracts/tsconfig.json`. No `bin` field
(repo convention: CLIs run via tsx npm scripts).

State dir `.do-harness/` (gitignored): `events.jsonl` (one JSON event per
line, append-only), `evidence.<set>.json` (overwritten per run).

`src/schemas.ts` (zod, all strings length-capped; `exactOptionalPropertyTypes`-safe):

- `SensorStatus = z.enum(["pass", "fail", "error", "skipped"])`
- `SignalSetName = z.enum(["feedback", "verification", "release"])`
- `WorkflowEvent = { seq int ≥1, atUtc ISO-8601, kind: "init" | "sensor_result" | "sensor_halted" | "errors_cleared", actor string 1..64, sensor? string 1..64, status? SensorStatus, exitCode? 0|1|2, durationMs? int ≥0, outputSha256? 64-hex, outputTail? string ≤2000, detail? string ≤512, chainHash 64-hex }`
- `SensorResult = { name string, ok boolean, status SensorStatus, exitCode 0|1|2, durationMs int ≥0, outputSha256? 64-hex, outputTail? string ≤2000, detail? string ≤512 }`
- `EvidenceReport = { schemaVersion: 1, set: SignalSetName, startedAtUtc, finishedAtUtc, sensors: SensorResult[], failed: string[], verdict: "green" | "red" }`

`src/store.ts`:

- `class DevHarnessError extends Error { kind: "usage" | "state-corruption" | "execution" }`
- `appendEvent(eventsDir, eventBody): Promise<WorkflowEvent>` — assigns `seq`
  (last + 1, or 1) and `chainHash = sha256(prevChainHash + "|" + canonicalJson(body))`;
  appends one line. Missing file starts the chain with empty prev hash.
- `readEvents(eventsDir): Promise<WorkflowEvent[]>` — validates each line
  against the schema, seq strictly increasing from 1, chain linkage
  `chainHash === sha256(prev + "|" + canonicalJson(body))`; any violation →
  `DevHarnessError("state-corruption")`. Missing file → `[]`.
- `canonicalJson(value)` (sorted keys), `sha256Hex(string)`,
  `EVENTS_FILE`, `DEFAULT_STATE_DIR`.

`src/strike.ts` (pure):

- `HALT_THRESHOLD = 3`
- `strikeState(events): Map<string, { consecutive: number; halted: boolean }>`
  — per sensor over ordered events: `sensor_result` pass → streak 0;
  fail/error → streak + 1; `errors_cleared` (that sensor, or all when no
  sensor named) → streak 0; `sensor_halted` → unchanged. `halted` = streak ≥ 3.

`src/sensors.ts`:

- `type SensorDef = { name, args: string[], sets: readonly SignalSetName[] }`
- `SENSOR_DEFS` (exact argv from `scripts/check.ts`, executed as
  `spawnSync(process.execPath, args, { cwd: repoRoot, timeout: 300_000, encoding: "utf8" })`):
  format (prettier --check .), lint (eslint .), typecheck (tsc -p tsconfig.json --noEmit),
  policy (tsx scripts/policy.ts), skills (tsx scripts/skills-check.ts),
  tests (vitest run), evals (tsx scripts/eval.ts), release (tsx scripts/release-check.ts).
- `SIGNAL_SETS`: feedback = format, lint, typecheck, policy, skills;
  verification = format..evals (all 7); release = verification + release sensor.
- `sensorNamesForSet(set)` (unknown → usage error; empty resolution impossible),
  `resolveSensor(name)` (unknown → usage error), `resolveEntry(def)` (missing
  node_modules entrypoint → usage error with "run npm install").
- `runSensor(def, repoRoot, opts?): { result fields, stdout, stderr }` —
  non-zero → status "fail"; spawn error / timeout / null status → status
  "error", exitCode 2; computes durationMs, outputSha256 = sha256(stdout+stderr),
  outputTail = last 2000 chars. Injectable for tests (synthetic defs).

`src/verify.ts`:

- `runSignalSet({ repoRoot, set, actor, failFast = false, eventsDir?, nowUtc?, sensorOverrides? }):
Promise<{ report: EvidenceReport; events: WorkflowEvent[]; exitCode: 0 | 1 | 2 }>`
  — reads events, computes strike state; halted sensors are skipped (SensorResult
  status "skipped", ok false, detail names the command
  `npm run signals -- errors clear --sensor <name>`), one `sensor_halted` event
  each; remaining sensors run sequentially (`failFast` stops after first
  failure, unrun sensors are simply absent); one `sensor_result` event per
  executed sensor; writes `evidence.<set>.json`; verdict green iff nothing
  failed and ≥1 sensor executed; exitCode 0/1 accordingly.

`src/cli.ts` (agent-integrate):

- `dev-harness <command>` run as `npm run signals -- <command>` (npm script
  `signals` = `tsx packages/dev-harness/src/cli.ts`).
- Commands: `init` (create state dir, append `init` event, validate sensor
  entrypoints); `verify [--set S] [--fail-fast] [--json] [--actor A]` (default
  set: verification; `--json` prints the EvidenceReport; exit 0 green / 1 red /
  2 usage-corruption); `status [--set S]` (per-sensor last recorded state
  green/red/missing + halted sensors; chain-validated; exit 0 all-green else 1,
  corruption → 2); `list` (sensors with sets + registered sets);
  `errors list | errors clear [--sensor NAME | --all]` (clear appends
  `errors_cleared` events); `hook install | uninstall | status`
  (`install` → `git config core.hooksPath .githooks`; outside a git repo →
  exit 2; `status` reports current hooksPath + managed-hook files).
- Exit codes: 0 / 1 / 2 only; usage errors print `dev-harness: …` to stderr.
- `test/cli.test.ts` must stay < 10 s: exercise `list`, unknown command → 2,
  `verify --set nope` → 2, `errors list` on a temp state dir; do NOT run real
  sensors in tests (the full `npm run check` provides the real receipt).

## Acceptance gate (DSH-06)

`npm run check` passes all 7 steps with the new package included;
`npm run eval:offline` passes; `npm run signals -- verify --set feedback`
exits 0 on a clean tree and writes events + evidence receipts; hook
dry-run (`sh .githooks/pre-commit`) exits 0; strike/halt behavior proven by
unit tests (3 consecutive failures → skip + halt diagnostic; `errors clear`
lifts it). No edits to `plans/invariants.json`, `scripts/policy.ts`, or
`.github/workflows` (approval boundaries respected).

## DSH-01 evidence (2026-09-13)

Files: `plans/adr/0007-dev-signal-harness.md` (new), this plan (new), root
`package.json` (+`signals`, `hooks:install` scripts), `.gitignore`
(+`.do-harness/`), `tsconfig.build.json` (+`packages/dev-harness` reference).
Research inputs: do-harness upstream digest (README, docs/cli.md,
do-harness.toml, db migrations 0001–0012, deepseek integration README) and
local conventions sweep; both treated as external data. Basis: Plan 000 D10
(concept references only), ADR 0004 precedent, ADR 0001 (no Python).

Risks / open questions: status "stale" detection (upstream workspace
fingerprints) deferred; event log grows unbounded (dev-scale, acceptable);
hooks assume Git Bash sh on Windows (repo's own shell).

## DSH-02 evidence (2026-09-13, agent-core)

**Files:** `packages/dev-harness/` (new package: `package.json`,
`tsconfig.json`, `src/schemas.ts`, `src/store.ts`, `src/strike.ts`,
`src/sensors.ts`, `src/verify.ts`, `src/index.ts`, `test/store.test.ts` (16),
`test/strike.test.ts` (12), `test/sensors.test.ts` (16), `test/verify.test.ts`
(6)).

**Design:** as frozen in this plan. Chain contract documented in `store.ts`:
`chainHash = sha256Hex(prev-or-"" + "|" + canonicalJson(event minus
chainHash))`; `readEvents` fails closed (state-corruption, with `file:line`)
on schema/seq/chain violations. Sensors mirror `scripts/check.ts` argv
exactly; entrypoint guard is lazy and scoped to the built-in registry so test
overrides with synthetic argv work. Strike state is pure; halt at 3
consecutive fail/error, pass and `errors_cleared` reset the streak, `skipped`
leaves it unchanged.

**Commands:** `npx vitest run packages/dev-harness` → 48/48 pass (1.2s);
`npm run check:fast` → 5/5 pass. Three defects found and fixed by the
agent's own checks: duplicate `WorkflowEvent` identifier in store.ts;
`exactOptionalPropertyTypes` widening in sensors.ts's `SensorRun`
construction; entrypoint guard misfiring on synthetic test argv.

**Risks:** none new beyond DSH-01's recorded deferrals.

## DSH-03 + DSH-04 evidence (2026-09-13, agent-wire)

**Files:** `.githooks/pre-commit` (new, exec feedback set `--fail-fast
--actor hook:pre-commit`), `.githooks/pre-push` (new, exec verification set
`--actor hook:pre-push`), `.agents/skills/dev-signals/SKILL.md` (new),
`README.md` (### Dev signal harness under Development), `AGENTS.md` (two
approved-command lines + one dev-signals paragraph).

**Commands:** `sh -n` both hooks → OK, LF-only (verified via `od -c`);
`npx prettier --check README.md AGENTS.md .agents/skills/dev-signals/SKILL.md`
→ clean; `npm run skills:check` → PASS (8 skills validated, +1); hooks staged
with mode 100755 via `git update-index --chmod=+x`. Orchestrator follow-up:
`.gitattributes` added (`.githooks/* text eol=lf`, `*.sh text eol=lf`) so
CRLF checkouts cannot break the shebangs.

## DSH-05 evidence (2026-09-13, agent-integrate)

**Files:** `packages/dev-harness/src/cli.ts` (new), `test/cli.test.ts` (new,
9 tests).

**Design:** full frozen command surface (`init`, `verify` with
`--set/--fail-fast/--json/--actor`, `status`, `list`,
`errors list|clear`, `hook install|uninstall|status`) plus a global
`--state-dir` (upstream `--root` parity) used by tests to target temp dirs.
Plain argv parsing, `dev-harness: …` errors on stderr, DevHarnessError kinds
mapped usage/state-corruption → 2, execution → 1. Deliberate deviation from
house style, recorded: `process.exitCode` instead of `process.exit(run())`
— the CLI is async and `process.exit` can truncate piped stdout on Windows;
exit codes verified to propagate through npm.

**Commands:** `npx vitest run packages/dev-harness` → 57/57 pass (48 core +
9 CLI, CLI suite 4.6s, no real sensors spawned); `npm run check:fast` →
5/5 pass; smoke: `signals -- list` → 0, `signals -- errors list` → 0,
`signals -- verify --set nope` → 2, `signals -- status` → 1 (all MISSING,
pre-receipt); both exact hook invocations validated to parse and reach
`runSignalSet`.

## DSH-06 evidence (2026-09-13, orchestrator)

**Files:** `plans/008` (statuses + this evidence), `.gitattributes` (new),
root `package.json` (+`signals`, `hooks:install`), `.gitignore`
(+`.do-harness/`), `tsconfig.build.json` (+`packages/dev-harness` reference).

**Commands:** `npx prettier --check .` → clean; `npm install` → up to date
(workspace linked); `npm run signals -- init` → state dir ready, event seq 1,
8 sensors / 3 sets listed; `sh .githooks/pre-commit` (dry-run) → feedback
set green (format 1938ms, lint 2191ms, typecheck 879ms, policy 306ms, skills
296ms), verdict green, receipt `.do-harness/evidence.feedback.json`, exit 0;
`npm run hooks:install` → `core.hooksPath = .githooks` (active);
`npm run check` → PASS all 7 steps (tests 5630ms, evals 343ms); `sh
.githooks/pre-push` → verification set green, receipt
`.do-harness/evidence.verification.json`, exit 0; `npm run eval:offline` →
PASS (21 deterministic cases, 0 network, 0 model calls); `npm run signals --
status` → all 7 sensors PASS, halted: none, status: green; event log: 13
hash-chained events.

**Acceptance gate:** met in full. No edits to `plans/invariants.json`,
`scripts/policy.ts`, or `.github/workflows`. Rust toolchain (cargo 1.95
available locally) intentionally unused per ADR 0007; zero LLM calls.

**Risks / open questions (register for later plans):** status staleness
(workspace-hash "stale" verdict) deferred; event log unbounded (dev scale);
`--json` verify path exercised by review only (needs a real sensor run to
test); pre-push runs the full verification set on every push by design —
if too heavy for daily use, a lighter push set can be added as a new signal
set without touching the frozen interface.
