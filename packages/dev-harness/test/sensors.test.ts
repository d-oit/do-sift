/**
 * dev-harness sensor tests (DSH-02): registry shape (argv mirrors
 * scripts/check.ts), set resolution (unknown/empty = usage error, INV-006),
 * entrypoint guard, and runSensor mapping — using synthetic defs executed as
 * spawnSync(process.execPath, …) so no real prettier/eslint/vitest runs here.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OUTPUT_TAIL_LIMIT,
  SENSOR_DEFS,
  SIGNAL_SETS,
  SignalSetName,
  DevHarnessError,
  resolveEntry,
  resolveSensor,
  runSensor,
  sensorNamesForSet,
  sha256Hex,
  type SensorDef,
} from "../src/index.js";

const ROOT = process.cwd();

function usageError(fn: () => unknown): DevHarnessError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DevHarnessError);
    return err as DevHarnessError;
  }
  throw new Error("expected the call to throw");
}

function def(name: string): SensorDef {
  const found = SENSOR_DEFS.find((d) => d.name === name);
  if (found === undefined) throw new Error(`missing sensor def: ${name}`);
  return found;
}

const okDef = (name: string): SensorDef => ({
  name,
  args: ["-e", "process.exit(0)"], // runSensor prepends process.execPath
  sets: ["feedback"],
});

describe("SENSOR_DEFS", () => {
  it("mirrors the scripts/check.ts steps in order", () => {
    expect(SENSOR_DEFS.map((d) => d.name)).toEqual([
      "format",
      "lint",
      "typecheck",
      "policy",
      "skills",
      "tests",
      "evals",
      "release",
    ]);
  });

  it("uses the exact per-step argv from scripts/check.ts", () => {
    const nm = (pkg: string, sub: string): string => join(ROOT, "node_modules", pkg, sub);
    expect(def("format").args).toEqual([nm("prettier", "bin/prettier.cjs"), "--check", "."]);
    expect(def("lint").args).toEqual([nm("eslint", "bin/eslint.js"), "."]);
    expect(def("typecheck").args).toEqual([
      nm("typescript", "bin/tsc"),
      "-p",
      join(ROOT, "tsconfig.json"),
      "--noEmit",
    ]);
    expect(def("policy").args).toEqual([nm("tsx", "dist/cli.mjs"), "scripts/policy.ts"]);
    expect(def("skills").args).toEqual([nm("tsx", "dist/cli.mjs"), "scripts/skills-check.ts"]);
    expect(def("tests").args).toEqual([nm("vitest", "vitest.mjs"), "run"]);
    expect(def("evals").args).toEqual([nm("tsx", "dist/cli.mjs"), "scripts/eval.ts"]);
    expect(def("release").args).toEqual([nm("tsx", "dist/cli.mjs"), "scripts/release-check.ts"]);
  });

  it("partitions sensors across the named signal sets", () => {
    const shared: SensorDef["sets"] = ["feedback", "verification", "release"];
    for (const name of ["format", "lint", "typecheck", "policy", "skills"]) {
      expect(def(name).sets).toEqual(shared);
    }
    expect(def("tests").sets).toEqual(["verification", "release"]);
    expect(def("evals").sets).toEqual(["verification", "release"]);
    expect(def("release").sets).toEqual(["release"]);
  });

  it("resolves real entrypoints in this repo", () => {
    for (const d of SENSOR_DEFS) {
      expect(existsSync(resolveEntry(d))).toBe(true);
    }
  });
});

describe("SIGNAL_SETS + sensorNamesForSet", () => {
  it("matches the frozen set composition", () => {
    expect([...SIGNAL_SETS.feedback]).toEqual(["format", "lint", "typecheck", "policy", "skills"]);
    expect([...SIGNAL_SETS.verification]).toEqual([
      "format",
      "lint",
      "typecheck",
      "policy",
      "skills",
      "tests",
      "evals",
    ]);
    expect([...SIGNAL_SETS.release]).toEqual([
      "format",
      "lint",
      "typecheck",
      "policy",
      "skills",
      "tests",
      "evals",
      "release",
    ]);
  });

  it("resolves sets in registry order, consistent with SIGNAL_SETS", () => {
    for (const name of SignalSetName.options) {
      expect(sensorNamesForSet(name)).toEqual([...SIGNAL_SETS[name]]);
    }
  });

  it("rejects unknown sets and empty resolutions as usage errors", () => {
    expect(usageError(() => sensorNamesForSet("nope")).kind).toBe("usage");
    expect(usageError(() => sensorNamesForSet("feedback", [])).kind).toBe("usage");
  });
});

describe("resolveSensor + resolveEntry", () => {
  it("resolves known sensors and rejects unknown ones", () => {
    expect(resolveSensor("format").name).toBe("format");
    expect(usageError(() => resolveSensor("nope")).kind).toBe("usage");
  });

  it("rejects a missing node_modules entrypoint with a run-npm-install hint", () => {
    const missing: SensorDef = {
      name: "ghost",
      args: [join(tmpdir(), "definitely-not-here.bin")],
      sets: ["feedback"],
    };
    const err = usageError(() => resolveEntry(missing));
    expect(err.kind).toBe("usage");
    expect(err.message).toContain("run npm install");
  });
});

describe("runSensor", () => {
  const cwd = tmpdir(); // an existing directory; the command is process.execPath

  it("maps exit 0 to pass", () => {
    const run = runSensor(okDef("ok"), cwd);
    expect(run).toMatchObject({ name: "ok", ok: true, status: "pass", exitCode: 0 });
    expect(run.outputSha256).toBe(sha256Hex(""));
    expect(run.outputTail).toBe("");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("maps a non-zero exit to fail with the exit code as returned", () => {
    const run = runSensor(
      {
        name: "boom",
        args: ["-e", "console.error('boom'); process.exit(1)"],
        sets: ["feedback"],
      },
      cwd,
    );
    expect(run).toMatchObject({ ok: false, status: "fail", exitCode: 1 });
    expect(run.stderr).toContain("boom");
    expect(run.outputSha256).toBe(sha256Hex(run.stdout + run.stderr));
    expect(run.detail).toBeUndefined();
  });

  it("keeps exit code 2 for a failing sensor", () => {
    const run = runSensor(
      { name: "two", args: ["-e", "process.exit(2)"], sets: ["feedback"] },
      cwd,
    );
    expect(run).toMatchObject({ ok: false, status: "fail", exitCode: 2 });
  });

  it("clamps exotic exit codes to 1 (schema admits only 0|1|2)", () => {
    const run = runSensor(
      { name: "seven", args: ["-e", "process.exit(7)"], sets: ["feedback"] },
      cwd,
    );
    expect(run).toMatchObject({ ok: false, status: "fail", exitCode: 1 });
  });

  it("surfaces a bad args path as a sensor failure via node's own exit code", () => {
    // runSensor's command is always process.execPath, so a nonexistent args
    // entry reaches node as a missing script (exit 1). A genuine spawn error
    // (res.error set) is exercised by the timeout test below.
    const run = runSensor(
      { name: "ghost", args: [join(tmpdir(), "definitely-not-here.bin")], sets: ["feedback"] },
      cwd,
    );
    expect(run).toMatchObject({ ok: false, status: "fail", exitCode: 1 });
    expect(run.stderr).toContain("Cannot find module");
  });

  it("maps a timeout to status error with exit code 2", () => {
    const run = runSensor(
      {
        name: "slow",
        args: ["-e", "setTimeout(() => {}, 10000)"],
        sets: ["feedback"],
      },
      cwd,
      { timeoutMs: 250 },
    );
    expect(run).toMatchObject({ ok: false, status: "error", exitCode: 2 });
    expect(run.durationMs).toBeLessThan(10_000);
  });

  it("captures stdout and truncates outputTail to the last 2000 chars", () => {
    const hello = runSensor(
      {
        name: "hello",
        args: ["-e", "console.log('hello world')"],
        sets: ["feedback"],
      },
      cwd,
    );
    expect(hello.stdout).toContain("hello world");
    expect(hello.outputSha256).toBe(sha256Hex(hello.stdout + hello.stderr));

    const big = runSensor(
      {
        name: "big",
        args: ["-e", "console.log('x'.repeat(3000))"],
        sets: ["feedback"],
      },
      cwd,
    );
    const combined = big.stdout + big.stderr;
    expect(combined.length).toBeGreaterThan(OUTPUT_TAIL_LIMIT);
    expect(big.outputTail).toBe(combined.slice(-OUTPUT_TAIL_LIMIT));
    expect(big.outputTail).toHaveLength(OUTPUT_TAIL_LIMIT);
  });
});
