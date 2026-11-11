/**
 * dev-harness CLI tests (DSH-05), shard 2 of 3: commands against a fresh
 * --state-dir (init, errors, status). See cli-support.ts for why the CLI
 * tests are sharded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readEvents } from "../index.js";
import { cleanupStateDirs, makeStateDir, runCli } from "./cli-support.js";

afterEach(cleanupStateDirs);

describe("dev-harness CLI (DSH-05): fresh state-dir commands", () => {
  it("init seeds a fresh state dir with a chain-valid init event", async () => {
    const dir = await makeStateDir();
    const res = runCli(["init", "--state-dir", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("init: state dir ready at");
    expect(res.stdout).toContain("sensors (13)");
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
});
