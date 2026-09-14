/**
 * dev-harness sensor registry + runner (DSH-02). SENSOR_DEFS mirror the exact
 * per-step argv of scripts/check.ts (FND-04), executed with the same no-shell
 * spawnSync(process.execPath, …) pattern. Entrypoints resolve against
 * process.cwd() exactly like check.ts; a missing entrypoint is a usage error
 * ("run npm install"). A signal set that resolves to zero sensors is a usage
 * error, never a vacuous pass (INV-006).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SignalSetName, type SensorResult, type SensorStatus } from "./schemas.js";
import { DevHarnessError, sha256Hex } from "./store.js";

/** A sensor = a named check command belonging to one or more signal sets. */
export type SensorDef = {
  name: string;
  args: string[];
  sets: readonly SignalSetName[];
};

/** Mirror of scripts/check.ts ROOT: entrypoints resolve against process.cwd(). */
const ROOT = process.cwd();

function nodeModulesEntry(pkg: string, sub: string): string {
  return join(ROOT, "node_modules", pkg, sub);
}

const TSX_CLI = nodeModulesEntry("tsx", "dist/cli.mjs");

/**
 * The repo's check steps as sensors; argv mirrors scripts/check.ts exactly
 * (release maps to the `release:check` npm script's entrypoint). Registry
 * order = check.ts step order, and therefore the signal-set run order.
 */
export const SENSOR_DEFS: readonly SensorDef[] = [
  {
    name: "format",
    args: [nodeModulesEntry("prettier", "bin/prettier.cjs"), "--check", "."],
    sets: ["feedback", "verification", "release"],
  },
  {
    name: "lint",
    args: [nodeModulesEntry("eslint", "bin/eslint.js"), "."],
    sets: ["feedback", "verification", "release"],
  },
  {
    name: "typecheck",
    args: [
      nodeModulesEntry("typescript", "bin/tsc"),
      "-p",
      join(ROOT, "tsconfig.json"),
      "--noEmit",
    ],
    sets: ["feedback", "verification", "release"],
  },
  {
    name: "policy",
    args: [TSX_CLI, "scripts/policy.ts"],
    sets: ["feedback", "verification", "release"],
  },
  {
    name: "skills",
    args: [TSX_CLI, "scripts/skills-check.ts"],
    sets: ["feedback", "verification", "release"],
  },
  {
    name: "tests",
    args: [nodeModulesEntry("vitest", "vitest.mjs"), "run"],
    sets: ["verification", "release"],
  },
  {
    name: "evals",
    args: [TSX_CLI, "scripts/eval.ts"],
    sets: ["verification", "release"],
  },
  {
    name: "release",
    args: [TSX_CLI, "scripts/release-check.ts"],
    sets: ["release"],
  },
];

function namesForSet(set: SignalSetName, registry: readonly SensorDef[]): string[] {
  const names = registry.filter((def) => def.sets.includes(set)).map((def) => def.name);
  if (names.length === 0) {
    throw new DevHarnessError("usage", `signal set "${set}" resolves to zero sensors (INV-006)`);
  }
  return names;
}

/** Named signal sets → ordered sensor names (derived from SENSOR_DEFS). */
export const SIGNAL_SETS: Record<SignalSetName, readonly string[]> = {
  feedback: namesForSet("feedback", SENSOR_DEFS),
  verification: namesForSet("verification", SENSOR_DEFS),
  release: namesForSet("release", SENSOR_DEFS),
};

/**
 * Ordered sensor names for a signal set. Unknown set names or an empty
 * resolution are usage errors, never vacuous passes (INV-006). `registry`
 * defaults to SENSOR_DEFS; runSignalSet passes an override for tests.
 */
export function sensorNamesForSet(
  set: string,
  registry: readonly SensorDef[] = SENSOR_DEFS,
): string[] {
  const parsed = SignalSetName.safeParse(set);
  if (!parsed.success) {
    throw new DevHarnessError(
      "usage",
      `unknown signal set "${set}" — expected one of: ${SignalSetName.options.join(", ")}`,
    );
  }
  return namesForSet(parsed.data, registry);
}

/** Resolve a sensor by name; unknown names are usage errors. */
export function resolveSensor(
  name: string,
  registry: readonly SensorDef[] = SENSOR_DEFS,
): SensorDef {
  const def = registry.find((d) => d.name === name);
  if (def === undefined) {
    throw new DevHarnessError(
      "usage",
      `unknown sensor "${name}" — known sensors: ${registry.map((d) => d.name).join(", ")}`,
    );
  }
  return def;
}

/**
 * Validate a def's entrypoint (args[0]); missing → usage error naming
 * "run npm install" (scripts/check.ts parity).
 */
export function resolveEntry(def: SensorDef): string {
  const entry = def.args[0];
  if (entry === undefined || !existsSync(entry)) {
    throw new DevHarnessError(
      "usage",
      `cannot locate ${def.name} entrypoint${entry === undefined ? "" : ` (${entry})`} — run npm install`,
    );
  }
  return entry;
}

export const DEFAULT_SENSOR_TIMEOUT_MS = 300_000;

/** outputTail keeps the last OUTPUT_TAIL_LIMIT chars of stdout+stderr. */
export const OUTPUT_TAIL_LIMIT = 2000;

export type RunSensorOptions = { timeoutMs?: number };

/**
 * One sensor run's receipt: the SensorResult fields plus raw stdout/stderr.
 * outputSha256 covers stdout+stderr concatenated; outputTail is the last
 * OUTPUT_TAIL_LIMIT chars of that same concatenation.
 */
export type SensorRun = Omit<SensorResult, "outputSha256" | "outputTail"> & {
  outputSha256: string;
  outputTail: string;
  stdout: string;
  stderr: string;
};

/**
 * Run one sensor as spawnSync(process.execPath, args, { cwd: repoRoot,
 * timeout, encoding: "utf8" }) — no shell. Mapping: exit 0 → pass; any other
 * exit → fail with the exit code as returned (non-zero codes outside 0|1|2
 * clamp to 1, which the frozen SensorResult/event schema admits); spawn
 * error, timeout, or missing exit status → status "error" with exitCode 2.
 * Injectable for tests via synthetic SensorDefs.
 */
export function runSensor(def: SensorDef, repoRoot: string, opts?: RunSensorOptions): SensorRun {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SENSOR_TIMEOUT_MS;
  const start = Date.now();
  const res = spawnSync(process.execPath, def.args, {
    cwd: repoRoot,
    timeout: timeoutMs,
    encoding: "utf8",
  });
  const durationMs = Date.now() - start;
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  const stderr = typeof res.stderr === "string" ? res.stderr : "";
  const combined = stdout + stderr;
  const outputSha256 = sha256Hex(combined);
  const outputTail =
    combined.length <= OUTPUT_TAIL_LIMIT ? combined : combined.slice(-OUTPUT_TAIL_LIMIT);

  let status: SensorStatus;
  let exitCode: 0 | 1 | 2;
  let detail: string | undefined;
  const spawnError = res.error;
  if (spawnError !== undefined && spawnError !== null) {
    status = "error";
    exitCode = 2;
    detail =
      (spawnError as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? `sensor "${def.name}" timed out after ${timeoutMs}ms`
        : `sensor "${def.name}" could not be spawned: ${spawnError.message}`;
  } else if (res.status === null) {
    status = "error";
    exitCode = 2;
    detail = `sensor "${def.name}" produced no exit status (signal: ${res.signal ?? "unknown"})`;
  } else if (res.status === 0) {
    status = "pass";
    exitCode = 0;
  } else {
    status = "fail";
    exitCode = res.status === 1 || res.status === 2 ? res.status : 1;
  }

  const run: SensorRun = {
    name: def.name,
    ok: status === "pass",
    status,
    exitCode,
    durationMs,
    outputSha256,
    outputTail,
    ...(detail === undefined ? {} : { detail }),
    stdout,
    stderr,
  };
  return run;
}
