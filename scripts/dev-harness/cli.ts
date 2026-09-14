/**
 * dev-harness CLI (DSH-05): the `npm run signals -- <command>` entrypoint over
 * the DSH-02 core (event store, strike/halt, sensor registry, runSignalSet).
 * Plain argv flag parsing per repo convention — no yargs/commander. Exit codes
 * (ADR 0007 upstream parity): 0 pass, 1 sensor failure / not-all-green, 2
 * usage or state-corruption error. DevHarnessError kinds map: "usage" and
 * "state-corruption" → 2, "execution" → 1; no exception escapes as an
 * unhandled crash. All failures print `dev-harness: …` to stderr; stdout is
 * reserved for reports/results. Frozen interface: plans/008-dev-signal-harness.md.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_STATE_DIR,
  DevHarnessError,
  SENSOR_DEFS,
  SIGNAL_SETS,
  appendEvent,
  readEvents,
  resolveEntry,
  resolveSensor,
  runSignalSet,
  sensorNamesForSet,
  statusVerdict,
  strikeState,
  type SensorStatus,
} from "./index.js";

/**
 * Parsed flags: bare `--flag` for booleans, `--flag value` or `--flag=value`
 * for VALUE_FLAGS. Unknown or misplaced flags are usage errors (exit 2).
 */
type Flags = Map<string, string | true>;

/** Flags that take a value when not written as `--flag=value`. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--state-dir",
  "--set",
  "--actor",
  "--sensor",
  "--only",
]);

/** Per-command accepted flags, on top of the global --state-dir. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: ["--actor"],
  verify: ["--set", "--fail-fast", "--json", "--actor", "--only"],
  status: ["--set"],
  list: [],
  "errors list": [],
  "errors clear": ["--actor", "--sensor", "--all"],
  "hook install": [],
  "hook uninstall": [],
  "hook status": [],
};

/** One-line usage, printed for no args / unknown command / unknown flag combos. */
const USAGE =
  "usage: dev-harness [--state-dir DIR] <command> — commands: init | verify [--set S] " +
  "[--only NAME] [--fail-fast] [--json] [--actor A] | status [--set S] | list | errors list | " +
  "errors clear [--sensor NAME | --all] | hook install | hook uninstall | hook status";

/** Per-status report tags; "skipped" is the halt-skip marker (frozen: HALTED). */
const STATUS_TAGS: Record<SensorStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  error: "ERROR",
  skipped: "HALTED",
};

function usageError(): DevHarnessError {
  return new DevHarnessError("usage", USAGE);
}

function nowUtc(): string {
  return new Date().toISOString();
}

function parseArgv(argv: readonly string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break; // satisfies noUncheckedIndexedAccess
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let name = arg;
    let value: string | true = true;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined) throw new DevHarnessError("usage", `flag ${arg} requires a value`);
      value = next;
      i += 1;
    }
    if (flags.has(name)) throw new DevHarnessError("usage", `duplicate flag ${name}`);
    flags.set(name, value);
  }
  return { positionals, flags };
}

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Flags, name: string): boolean {
  return flags.get(name) === true;
}

/** Reject flags the command does not accept (--state-dir is global). */
function assertKnownFlags(commandKey: string, flags: Flags): void {
  const allowed = COMMAND_FLAGS[commandKey];
  if (allowed === undefined) throw usageError();
  for (const name of flags.keys()) {
    if (name !== "--state-dir" && !allowed.includes(name)) throw usageError();
  }
}

// ---- init ------------------------------------------------------------------

async function cmdInit(stateDir: string, actor: string): Promise<number> {
  // Entrypoint guard first: a broken install fails before any state is written.
  for (const def of SENSOR_DEFS) resolveEntry(def);
  await mkdir(stateDir, { recursive: true });
  const event = await appendEvent(stateDir, { kind: "init", atUtc: nowUtc(), actor });
  console.log(
    `init: state dir ready at ${stateDir} (event seq ${event.seq}, actor ${event.actor})`,
  );
  console.log(`sensors (${SENSOR_DEFS.length}):`);
  for (const def of SENSOR_DEFS) console.log(`  ${def.name}: ${def.sets.join(", ")}`);
  const sets = Object.entries(SIGNAL_SETS);
  console.log(`signal sets (${sets.length}):`);
  for (const [name, sensors] of sets) {
    console.log(`  ${name} (${sensors.length}): ${sensors.join(", ")}`);
  }
  return 0;
}

// ---- verify ----------------------------------------------------------------

/**
 * Workspace fingerprint (DSH-07): content-based — sha-256 over the sorted
 * (path, content hash) pairs of every tracked and untracked non-ignored
 * file. A first porcelain-based design (git status text) was live-verified
 * ineffective: the status output does not change when an already-modified or
 * already-untracked file is edited again, so iterative edits kept stale
 * receipts green. Undefined outside a git repo — staleness is then
 * unjudgeable and stays green (backward compat).
 */
function computeWorkspaceFingerprint(): string | undefined {
  const tracked = runGit(["ls-files", "-z"]);
  const others = runGit(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!tracked.ok || !others.ok) return undefined;
  const paths = [...tracked.output.split("\0"), ...others.output.split("\0")]
    .filter((p) => p.length > 0)
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(`${path}\0`);
    try {
      hash.update(readFileSync(join(process.cwd(), path)));
    } catch {
      hash.update("missing"); // tracked file deleted from the worktree
    }
  }
  return hash.digest("hex");
}

async function cmdVerify(
  stateDir: string,
  set: string,
  actor: string,
  failFast: boolean,
  json: boolean,
  only: string | undefined,
): Promise<number> {
  const workspaceSha256 = computeWorkspaceFingerprint();
  const { report, exitCode } = await runSignalSet({
    repoRoot: process.cwd(),
    set,
    actor,
    failFast,
    eventsDir: stateDir,
    ...(only === undefined ? {} : { only }),
    ...(workspaceSha256 === undefined ? {} : { workspaceSha256 }),
  });
  if (json) {
    // --json prints ONLY the EvidenceReport JSON on stdout (frozen interface).
    console.log(JSON.stringify(report, null, 2));
    return exitCode;
  }
  for (const sensor of report.sensors) {
    console.log(`${STATUS_TAGS[sensor.status]}  ${sensor.name}  ${sensor.durationMs}ms`);
    if (sensor.status === "skipped" && sensor.detail !== undefined) {
      console.log(`  ${sensor.detail}`);
    }
  }
  console.log(`verdict: ${report.verdict}`);
  console.log(`receipt: ${join(stateDir, `evidence.${report.set}.json`)}`);
  return exitCode;
}

// ---- status ----------------------------------------------------------------

async function cmdStatus(stateDir: string, set: string): Promise<number> {
  const names = sensorNamesForSet(set); // unknown set → usage error (exit 2)
  const events = await readEvents(stateDir); // state-corruption → exit 2
  const last = new Map<
    string,
    { status: SensorStatus; atUtc: string; workspaceSha256?: string | undefined }
  >();
  for (const event of events) {
    if (
      event.kind === "sensor_result" &&
      event.status !== undefined &&
      event.sensor !== undefined
    ) {
      last.set(event.sensor, {
        status: event.status,
        atUtc: event.atUtc,
        ...(event.workspaceSha256 === undefined ? {} : { workspaceSha256: event.workspaceSha256 }),
      });
    }
  }
  const current = computeWorkspaceFingerprint();
  console.log(`status (set ${set}, state dir ${stateDir}):`);
  const verdicts: string[] = [];
  for (const name of names) {
    const entry = last.get(name);
    const verdict = statusVerdict(
      entry === undefined
        ? undefined
        : {
            status: entry.status,
            ...(entry.workspaceSha256 === undefined
              ? {}
              : { workspaceSha256: entry.workspaceSha256 }),
          },
      current,
    );
    verdicts.push(verdict);
    if (entry === undefined) {
      console.log("MISSING  " + name);
    } else {
      // green keeps the precise PASS tag; red keeps FAIL/ERROR/HALTED
      const tag = verdict === "stale" ? "STALE" : STATUS_TAGS[entry.status];
      console.log(`${tag}  ${name}  ${entry.atUtc}`);
    }
  }
  const halted = [...strikeState(events)].filter(([, strike]) => strike.halted);
  console.log(
    halted.length === 0
      ? "halted: none"
      : `halted: ${halted.map(([name, strike]) => `${name} (streak ${strike.consecutive})`).join(", ")}`,
  );
  const allGreen = verdicts.every((v) => v === "green");
  const anyRed = verdicts.some((v) => v === "red");
  const anyStale = verdicts.some((v) => v === "stale");
  console.log(
    allGreen
      ? "status: green"
      : anyRed
        ? "status: red"
        : anyStale
          ? "status: stale — the working tree changed since the last receipt; rerun: npm run signals -- verify"
          : "status: red", // nothing verified yet (frozen all-missing semantics)
  );
  return allGreen ? 0 : 1;
}

// ---- list ------------------------------------------------------------------

function cmdList(): number {
  console.log(`sensors (${SENSOR_DEFS.length}):`);
  for (const def of SENSOR_DEFS) console.log(`  ${def.name}: ${def.sets.join(", ")}`);
  const sets = Object.entries(SIGNAL_SETS);
  console.log(`signal sets (${sets.length}):`);
  for (const [name, sensors] of sets) {
    console.log(`  ${name}: ${sensors.join(", ")}`);
  }
  return 0;
}

// ---- errors ----------------------------------------------------------------

async function cmdErrorsList(stateDir: string): Promise<number> {
  const strikes = strikeState(await readEvents(stateDir)); // pure computation over the log
  if (strikes.size === 0) {
    console.log(`strikes (${stateDir}): none`);
    return 0;
  }
  console.log(`strikes (${stateDir}):`);
  for (const [name, strike] of strikes) {
    console.log(`  ${name}  streak ${strike.consecutive}${strike.halted ? "  HALTED" : ""}`);
  }
  return 0;
}

async function cmdErrorsClear(stateDir: string, actor: string, flags: Flags): Promise<number> {
  const sensor = flagString(flags, "--sensor");
  const all = flags.has("--all");
  if (all === (sensor !== undefined)) {
    throw new DevHarnessError("usage", "errors clear needs exactly one of --sensor NAME or --all");
  }
  if (sensor !== undefined) resolveSensor(sensor); // unknown name → usage error (exit 2)
  await appendEvent(stateDir, {
    kind: "errors_cleared",
    atUtc: nowUtc(),
    actor,
    ...(sensor === undefined ? {} : { sensor }),
  });
  console.log(
    sensor === undefined
      ? "cleared: all sensors (strike streaks reset)"
      : `cleared: ${sensor} (strike streak reset)`,
  );
  return 0;
}

// ---- hook ------------------------------------------------------------------

function runGit(args: readonly string[]): { ok: boolean; output: string } {
  const res = spawnSync("git", args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (res.error !== undefined && res.error !== null) {
    return { ok: false, output: res.error.message };
  }
  if (res.status !== 0) {
    const text = `${res.stderr}${res.stdout}`.trim();
    return {
      ok: false,
      output: `git ${args.join(" ")} failed (status ${String(res.status)}): ${text.length > 0 ? text : "no output"}`,
    };
  }
  return { ok: true, output: res.stdout.trim() };
}

function currentHooksPath(): string {
  const res = runGit(["config", "core.hooksPath"]);
  return res.ok ? res.output : "";
}

function hookFileExists(hook: string): boolean {
  return existsSync(join(process.cwd(), ".githooks", hook));
}

function cmdHook(sub: string): number {
  if (sub === "status") {
    const hooksPath = currentHooksPath();
    console.log(`hooksPath: ${hooksPath === "" ? "unset" : hooksPath}`);
    for (const hook of ["pre-commit", "pre-push"]) {
      const state = hookFileExists(hook) ? "present" : "missing";
      const active = hooksPath === ".githooks" && hookFileExists(hook) ? " (active)" : "";
      console.log(`${hook} (.githooks/${hook}): ${state}${active}`);
    }
    return 0;
  }
  if (sub === "install") {
    const missing = ["pre-commit", "pre-push"].filter((hook) => !hookFileExists(hook));
    if (missing.length > 0) {
      throw new DevHarnessError(
        "usage",
        `managed hook file(s) missing: ${missing.map((hook) => `.githooks/${hook}`).join(", ")}`,
      );
    }
    const res = runGit(["config", "core.hooksPath", ".githooks"]);
    if (!res.ok) throw new DevHarnessError("usage", res.output);
    console.log("hooks installed: git config core.hooksPath = .githooks (pre-commit, pre-push)");
    return 0;
  }
  // uninstall: only touch a hooksPath dev-harness itself manages.
  const current = currentHooksPath();
  if (current !== ".githooks") {
    console.log(
      `nothing to uninstall: hooksPath is ${current === "" ? "unset" : `"${current}"`} (dev-harness only manages ".githooks")`,
    );
    return 0;
  }
  const res = runGit(["config", "--unset", "core.hooksPath"]);
  if (!res.ok) throw new DevHarnessError("usage", res.output);
  console.log("hooks uninstalled: core.hooksPath unset (was .githooks)");
  return 0;
}

// ---- dispatch --------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgv(argv);
  const stateDir = flagString(flags, "--state-dir") ?? join(process.cwd(), DEFAULT_STATE_DIR);
  if (stateDir.length === 0) {
    throw new DevHarnessError("usage", "--state-dir must not be empty");
  }
  const actorFlag = flagString(flags, "--actor");
  if (actorFlag !== undefined && (actorFlag.length === 0 || actorFlag.length > 64)) {
    throw new DevHarnessError("usage", `actor must be 1..64 characters, got ${actorFlag.length}`);
  }
  const actor = actorFlag ?? "cli";

  const head = positionals[0];
  if (head === undefined) throw usageError();

  if (head === "init") {
    if (positionals.length !== 1) throw usageError();
    assertKnownFlags("init", flags);
    return cmdInit(stateDir, actor);
  }
  if (head === "verify") {
    if (positionals.length !== 1) throw usageError();
    assertKnownFlags("verify", flags);
    return cmdVerify(
      stateDir,
      flagString(flags, "--set") ?? "verification",
      actor,
      flagBool(flags, "--fail-fast"),
      flagBool(flags, "--json"),
      flagString(flags, "--only"),
    );
  }
  if (head === "status") {
    if (positionals.length !== 1) throw usageError();
    assertKnownFlags("status", flags);
    return cmdStatus(stateDir, flagString(flags, "--set") ?? "verification");
  }
  if (head === "list") {
    if (positionals.length !== 1) throw usageError();
    assertKnownFlags("list", flags);
    return cmdList();
  }
  if (head === "errors" || head === "hook") {
    const sub = positionals[1];
    if (sub === undefined || positionals.length !== 2) throw usageError();
    assertKnownFlags(`${head} ${sub}`, flags); // unknown subcommand → usage error
    if (head === "errors") {
      if (sub === "list") return cmdErrorsList(stateDir);
      if (sub === "clear") return cmdErrorsClear(stateDir, actor, flags);
    } else if (sub === "install" || sub === "uninstall" || sub === "status") {
      return cmdHook(sub);
    }
  }
  throw usageError();
}

main(process.argv.slice(2)).then(
  (code) => {
    // Exit code assignment (not process.exit) lets piped stdout/stderr flush
    // before the process ends — report output is never truncated.
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof DevHarnessError) {
      console.error(err.message); // already prefixed "dev-harness: "
      process.exitCode = err.kind === "execution" ? 1 : 2;
    } else {
      console.error(`dev-harness: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  },
);
