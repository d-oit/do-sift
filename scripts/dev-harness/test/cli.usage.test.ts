/**
 * dev-harness CLI tests (DSH-05), shard 1 of 3: usage errors and read-only
 * commands. See cli-support.ts for why the CLI tests are sharded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStateDirs, makeStateDir, runCli } from "./cli-support.js";

afterEach(cleanupStateDirs);

describe("dev-harness CLI (DSH-05): usage and read-only commands", () => {
  it("list prints built-in sensors and signal sets and exits 0", () => {
    const res = runCli(["list"]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("dev-harness:");
    for (const sensor of [
      "format",
      "lint",
      "typecheck",
      "policy",
      "guardrails",
      "skills",
      "governance",
      "tests",
      "evals",
      "release",
    ]) {
      expect(res.stdout).toContain(sensor);
    }
    for (const set of ["feedback", "verification", "release"]) {
      expect(res.stdout).toContain(set);
    }
  });

  it("unknown command prints one-line usage to stderr and exits 2", () => {
    const res = runCli(["frobnicate"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("dev-harness: usage:");
    expect(res.stderr.trimEnd().split("\n")).toHaveLength(1); // one line
    expect(res.stdout).toBe("");
  });

  it("no args and unknown flags are usage errors (exit 2)", () => {
    const noArgs = runCli([]);
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toContain("dev-harness: usage:");

    const badFlag = runCli(["list", "--frobnicate"]);
    expect(badFlag.status).toBe(2);
    expect(badFlag.stderr).toContain("dev-harness: usage:");
    expect(badFlag.stdout).toBe("");
  });

  it("verify with an unknown set is a usage error, never a vacuous pass", async () => {
    const dir = await makeStateDir();
    const res = runCli(["verify", "--set", "nope", "--state-dir", dir]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("dev-harness:");
    expect(res.stderr).toContain("nope");
    expect(res.stdout).toBe("");
  });

  it("hook status exits 0 and reports the current hooksPath", () => {
    const res = runCli(["hook", "status"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("hooksPath:");
    expect(res.stdout).toContain("pre-commit (.githooks/pre-commit):");
    expect(res.stdout).toContain("pre-push (.githooks/pre-push):");
    expect(res.stderr).not.toContain("dev-harness:");
  });
});
