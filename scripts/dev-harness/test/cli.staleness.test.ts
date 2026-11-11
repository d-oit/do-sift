/**
 * dev-harness CLI tests, shard 3 of 3: staleness and --only/--json
 * (DSH-07/DSH-08, plan 010). Includes the one deliberate real-sensor run.
 * See cli-support.ts for why the CLI tests are sharded.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, SENSOR_DEFS, sha256Hex } from "../index.js";
import { cleanupStateDirs, makeStateDir, runCli } from "./cli-support.js";

afterEach(cleanupStateDirs);

describe("dev-harness CLI (DSH-07/DSH-08): staleness and --only/--json", () => {
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

  it("status flags red and exits 1 when an evidence receipt is malformed or uses unknown schema version", async () => {
    const dir = await makeStateDir();
    await seedPass(dir);
    await writeFile(
      join(dir, "evidence.feedback.json"),
      JSON.stringify({ schemaVersion: 99, set: "feedback" }),
    );
    const res = runCli(["status", "--set", "feedback", "--state-dir", dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("status: red");
    expect(res.stdout).toContain("malformed or uses an unknown schema version");
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
