/**
 * dev-harness run orchestrator tests (DSH-02): green/red verdicts, chained
 * event appends, evidence receipts, fail-fast, strike/halt skip + lift, and
 * usage errors — all with synthetic sensor defs (process.execPath no-ops) and
 * a temp state dir, so no real repo checks run here.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_DIR,
  DevHarnessError,
  HALT_THRESHOLD,
  appendEvent,
  readEvents,
  runSignalSet,
  sha256Hex,
  type EvidenceReport,
  type SensorDef,
  type WorkflowEventBody,
} from "../index.js";

const NOW = "2026-01-01T00:00:00.000Z";
const clock = (): string => NOW;

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "do-sift-verify-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

const okDef = (name: string): SensorDef => ({
  name,
  args: ["-e", "process.exit(0)"], // runSensor prepends process.execPath
  sets: ["feedback"],
});
const failDef = (name: string): SensorDef => ({
  name,
  args: ["-e", "process.exit(1)"],
  sets: ["feedback"],
});

function seededFailure(sensor: string): WorkflowEventBody {
  return {
    kind: "sensor_result",
    atUtc: NOW,
    actor: "cli",
    sensor,
    status: "fail",
    exitCode: 1,
    durationMs: 1,
    outputSha256: sha256Hex("x"),
    outputTail: "",
  };
}

async function usageOf(promise: Promise<unknown>): Promise<DevHarnessError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DevHarnessError);
    return err as DevHarnessError;
  }
  throw new Error("expected the promise to reject");
}

describe("runSignalSet", () => {
  it("runs a green set, appends chained events, and writes an evidence receipt", async () => {
    const root = await makeDir();
    const first = await runSignalSet({
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: [okDef("alpha"), okDef("beta")],
    });
    expect(first.exitCode).toBe(0);
    expect(first.report.verdict).toBe("green");
    expect(first.report.schemaVersion).toBe(1);
    expect(first.report.set).toBe("feedback");
    expect(first.report.startedAtUtc).toBe(NOW);
    expect(first.report.finishedAtUtc).toBe(NOW);
    expect(first.report.failed).toEqual([]);
    expect(first.report.sensors.map((s) => [s.name, s.ok, s.status])).toEqual([
      ["alpha", true, "pass"],
      ["beta", true, "pass"],
    ]);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.events.every((e) => e.kind === "sensor_result")).toBe(true);
    expect(first.events[0]).toMatchObject({
      kind: "sensor_result",
      actor: "cli",
      sensor: "alpha",
      status: "pass",
      exitCode: 0,
      atUtc: NOW,
    });
    expect(first.events[0]?.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(typeof first.events[0]?.durationMs).toBe("number");

    // Receipt at the default state dir, byte-equal to the report object.
    const receiptPath = join(root, DEFAULT_STATE_DIR, "evidence.feedback.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as EvidenceReport;
    expect(receipt).toEqual(first.report);

    // The log re-validates, and a second run continues the chain.
    await expect(readEvents(join(root, DEFAULT_STATE_DIR))).resolves.toHaveLength(2);
    const second = await runSignalSet({
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: [okDef("alpha")],
    });
    expect(second.events.map((e) => e.seq)).toEqual([3]);
    await expect(readEvents(join(root, DEFAULT_STATE_DIR))).resolves.toHaveLength(3);
  });

  it("records failures red and honors fail-fast", async () => {
    const root = await makeDir();
    const overrides = [okDef("alpha"), failDef("boom"), okDef("gamma")];
    const full = await runSignalSet({
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: overrides,
    });
    expect(full.report.verdict).toBe("red");
    expect(full.exitCode).toBe(1);
    expect(full.report.failed).toEqual(["boom"]);
    expect(full.report.sensors).toHaveLength(3);

    const fast = await runSignalSet({
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: overrides,
      failFast: true,
    });
    expect(fast.report.sensors.map((s) => s.name)).toEqual(["alpha", "boom"]);
    expect(fast.report.sensors.some((s) => s.name === "gamma")).toBe(false); // simply absent
    expect(fast.events).toHaveLength(2);
    expect(fast.exitCode).toBe(1);
  });

  it("skips halted sensors with a clear instruction and still runs the rest", async () => {
    const dir = await makeDir();
    for (let i = 0; i < HALT_THRESHOLD; i++) {
      await appendEvent(dir, seededFailure("flaky"));
    }
    const res = await runSignalSet({
      repoRoot: dir,
      set: "feedback",
      actor: "hook:pre-commit",
      nowUtc: clock,
      eventsDir: dir, // seeded directly into dir above
      sensorOverrides: [failDef("flaky"), okDef("healthy")],
    });
    const [flaky, healthy] = res.report.sensors;
    expect(flaky).toMatchObject({ name: "flaky", ok: false, status: "skipped", exitCode: 2 });
    expect(flaky?.detail).toContain("npm run signals -- errors clear --sensor flaky");
    expect(healthy).toMatchObject({ name: "healthy", ok: true, status: "pass" });
    expect(res.report.failed).toEqual(["flaky"]);
    expect(res.report.verdict).toBe("red");
    expect(res.exitCode).toBe(1);
    expect(res.events.map((e) => e.kind)).toEqual(["sensor_halted", "sensor_result"]);
    expect(res.events[0]?.sensor).toBe("flaky");
    // The log stays chain-valid after the halt event.
    await expect(readEvents(dir)).resolves.toHaveLength(HALT_THRESHOLD + 2);
  });

  it("lifts a halt after errors clear", async () => {
    const dir = await makeDir();
    for (let i = 0; i < HALT_THRESHOLD; i++) {
      await appendEvent(dir, seededFailure("flaky"));
    }
    const halted = await runSignalSet({
      repoRoot: dir,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      eventsDir: dir, // seeded directly into dir above
      sensorOverrides: [failDef("flaky")],
    });
    expect(halted.report.sensors[0]?.status).toBe("skipped");

    await appendEvent(dir, { kind: "errors_cleared", atUtc: NOW, actor: "cli", sensor: "flaky" });
    const after = await runSignalSet({
      repoRoot: dir,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      eventsDir: dir,
      sensorOverrides: [okDef("flaky")],
    });
    expect(after.report.sensors[0]?.status).toBe("pass");
    expect(after.report.verdict).toBe("green");
    expect(after.exitCode).toBe(0);
  });

  it("throws usage errors for unknown sets, empty registries, and bad actors", async () => {
    const root = await makeDir();
    const base = {
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: [okDef("alpha")],
    };
    expect((await usageOf(runSignalSet({ ...base, set: "nope" }))).kind).toBe("usage");
    expect((await usageOf(runSignalSet({ ...base, sensorOverrides: [] }))).kind).toBe("usage");
    expect((await usageOf(runSignalSet({ ...base, actor: "" }))).kind).toBe("usage");
    expect((await usageOf(runSignalSet({ ...base, actor: "x".repeat(65) }))).kind).toBe("usage");
  });

  it("propagates state corruption from the event log", async () => {
    const root = await makeDir();
    const stateDir = join(root, DEFAULT_STATE_DIR);
    await appendEvent(stateDir, seededFailure("flaky"));
    const raw = await readFile(join(stateDir, "events.jsonl"), "utf8");
    await writeFile(join(stateDir, "events.jsonl"), `${raw}not-json\n`, "utf8");
    const err = await usageOf(
      runSignalSet({
        repoRoot: root,
        set: "feedback",
        actor: "cli",
        nowUtc: clock,
        sensorOverrides: [okDef("alpha")], // keeps the run itself synthetic
      }),
    );
    expect(err.kind).toBe("state-corruption");
  });

  it("stamps the workspace fingerprint on events and the receipt (DSH-07)", async () => {
    const root = await makeDir();
    const fingerprint = sha256Hex("workspace-under-test");
    const res = await runSignalSet({
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: [okDef("alpha")],
      workspaceSha256: fingerprint,
    });
    expect(res.events[0]?.workspaceSha256).toBe(fingerprint);
    expect(res.report.workspaceSha256).toBe(fingerprint);
    const receipt = JSON.parse(
      await readFile(join(root, DEFAULT_STATE_DIR, "evidence.feedback.json"), "utf8"),
    ) as EvidenceReport;
    expect(receipt.workspaceSha256).toBe(fingerprint);
  });

  it("runs a single set member with only, and refuses non-members (DSH-08)", async () => {
    const root = await makeDir();
    const res = await runSignalSet({
      repoRoot: root,
      set: "feedback",
      actor: "cli",
      nowUtc: clock,
      sensorOverrides: [okDef("alpha"), okDef("beta")],
      only: "beta",
    });
    expect(res.report.sensors.map((s) => s.name)).toEqual(["beta"]);
    expect(res.report.verdict).toBe("green");
    expect(res.exitCode).toBe(0);
    const err = await usageOf(
      runSignalSet({
        repoRoot: root,
        set: "feedback",
        actor: "cli",
        nowUtc: clock,
        sensorOverrides: [okDef("alpha"), okDef("beta")],
        only: "gamma", // valid sensor name, but not in the feedback set
      }),
    );
    expect(err.kind).toBe("usage");
  });
});
