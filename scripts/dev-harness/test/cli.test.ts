/**
 * dev-harness CLI tests (DSH-05): spawn the real CLI through tsx
 * (`node node_modules/tsx/dist/cli.mjs scripts/dev-harness/cli.ts`, the
 * same invocation npm run signals and the git hooks use) with a fresh
 * os.tmpdir() --state-dir per test. Only state-free and empty-state paths run
 * here — no real sensors (plan 008: the real `verify` receipt belongs to
 * `npm run check` and the orchestrator's DSH-06 run).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEvent, readEvents, SENSOR_DEFS, sha256Hex } from "../index.js";

// The CLI tests spawn real node+tsx processes; under full-suite parallel
// load on Windows a cold spawn can exceed the 5s default (observed once:
// `list` timed out at 5000ms in a verification-set run). 30s headroom —
// every assertion stays unchanged.
vi.setConfig({ testTimeout: 30_000 });

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY = join(REPO_ROOT, "scripts", "dev-harness", "cli.ts");

const dirs: string[] = [];
async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "do-sift-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

describe("dev-harness CLI (DSH-05)", () => {
  it("list prints built-in sensors and signal sets and exits 0", () => {
    const res = runCli(["list"]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("dev-harness:");
    for (const sensor of [
      "format",
      "lint",
      "typecheck",
      "policy",
      "skills",
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

  it("init seeds a fresh state dir with a chain-valid init event", async () => {
    const dir = await makeStateDir();
    const res = runCli(["init", "--state-dir", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("init: state dir ready at");
    expect(res.stdout).toContain("sensors (8)");
    expect(res.stdout).toContain("signal sets (3)");
    const events = await readEvents(dir); // re-validates schema + chain
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "init", actor: "cli", seq: 1 });
  });

  it("errors list on a fresh state dir exits 0 with zero strikes", async () => {
    const dir = await makeStateDir();
    const res = runCli(["errors", "list", "--state-dir", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("none");
    expect(res.stdout).not.toContain("HALTED");
    expect(res.stderr).not.toContain("dev-harness:");
  });

  it("errors clear rejects unknown sensor names and appends a clear event for known ones", async () => {
    const dir = await makeStateDir();
    const unknown = runCli(["errors", "clear", "--sensor", "nope", "--state-dir", dir]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("dev-harness:");

    const all = runCli(["errors", "clear", "--all", "--state-dir", dir]);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("cleared: all sensors");
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "errors_cleared", actor: "cli" });
    expect(events[0]?.sensor).toBeUndefined();
  });

  it("status on a fresh state dir reports every sensor missing and exits 1", async () => {
    const dir = await makeStateDir();
    const res = runCli(["status", "--state-dir", dir]);
    expect(res.status).toBe(1); // all missing → not all green
    expect(res.stdout).toContain("MISSING  format");
    expect(res.stdout).toContain("MISSING  evals");
    expect(res.stdout).toContain("halted: none");
    expect(res.stdout).toContain("status: red");
    expect(res.stderr).not.toContain("dev-harness:"); // corruption-free output
  });

  it("hook status exits 0 and reports the current hooksPath", () => {
    const res = runCli(["hook", "status"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("hooksPath:");
    expect(res.stdout).toContain("pre-commit (.githooks/pre-commit):");
    expect(res.stdout).toContain("pre-push (.githooks/pre-push):");
    expect(res.stderr).not.toContain("dev-harness:");
  });

  // ---- DSH-07/DSH-08 (plan 010): staleness + --only/--json ------------------

  const FEEDBACK_SENSORS = SENSOR_DEFS.filter((d) => d.sets.includes("feedback")).map(
    (d) => d.name,
  );
  const NOW = "2026-01-01T00:00:00.000Z";

  async function seedPass(dir: string, workspaceSha256?: string): Promise<void> {
    for (const name of FEEDBACK_SENSORS) {
      await appendEvent(dir, {
        kind: "sensor_result",
        atUtc: NOW,
        actor: "cli",
        sensor: name,
        status: "pass",
        exitCode: 0,
        durationMs: 1,
        ...(workspaceSha256 === undefined ? {} : { workspaceSha256 }),
      });
    }
  }

  it("status flags STALE when the recorded fingerprint differs from the current tree", async () => {
    const dir = await makeStateDir();
    await seedPass(dir, sha256Hex("not-the-real-working-tree"));
    const res = runCli(["status", "--set", "feedback", "--state-dir", dir]);
    expect(res.status).toBe(1); // stale is not green
    expect(res.stdout).toContain("STALE  format");
    expect(res.stdout).toContain("STALE  skills");
    expect(res.stdout).toContain("status: stale");
    expect(res.stderr).not.toContain("dev-harness:");
  });

  it("status stays green for pre-fingerprint receipts (backward compatible)", async () => {
    const dir = await makeStateDir();
    await seedPass(dir); // no workspaceSha256: pre-DSH-07 events
    const res = runCli(["status", "--set", "feedback", "--state-dir", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS  format");
    expect(res.stdout).toContain("status: green");
    expect(res.stdout).not.toContain("STALE");
  });

  it("verify --json --only skills runs one real sensor and prints the receipt (DSH-08)", async () => {
    const dir = await makeStateDir();
    // Deliberate deviation from plan 008's "no real sensors" CLI-test rule,
    // sanctioned by plan 010: exactly one fast real sensor (~1s) closes the
    // deferred "--json needs a real sensor run" coverage gap.
    const res = runCli([
      "verify",
      "--json",
      "--set",
      "feedback",
      "--only",
      "skills",
      "--state-dir",
      dir,
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("dev-harness:");
    const report = JSON.parse(res.stdout) as {
      schemaVersion: number;
      set: string;
      verdict: string;
      workspaceSha256?: string;
      sensors: Array<{ name: string; status: string }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.set).toBe("feedback");
    expect(report.verdict).toBe("green");
    expect(report.sensors).toHaveLength(1);
    expect(report.sensors[0]).toMatchObject({ name: "skills", status: "pass" });
    expect(report.workspaceSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("verify --only with a non-member of the set is a usage error (DSH-08)", async () => {
    const dir = await makeStateDir();
    const res = runCli(["verify", "--only", "evals", "--set", "feedback", "--state-dir", dir]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("dev-harness:");
    expect(res.stdout).toBe("");
  });
});
