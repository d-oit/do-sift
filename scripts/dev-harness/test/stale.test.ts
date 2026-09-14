/**
 * Dev-signal staleness tests (DSH-07, plan 010): the pure statusVerdict
 * matrix, and a fingerprint-stamped event round-tripping through the store.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, readEvents, sha256Hex, statusVerdict } from "../index.js";

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "do-sift-stale-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

const FP_A = sha256Hex("workspace-a");
const FP_B = sha256Hex("workspace-b");

describe("statusVerdict", () => {
  it("missing when no receipt exists", () => {
    expect(statusVerdict(undefined, FP_A)).toBe("missing");
    expect(statusVerdict(undefined, undefined)).toBe("missing");
  });

  it("green when the last receipt passed — with, without, or unjudgeable fingerprints", () => {
    expect(statusVerdict({ status: "pass" }, FP_A)).toBe("green"); // pre-DSH-07 event
    expect(statusVerdict({ status: "pass", workspaceSha256: FP_A }, FP_A)).toBe("green");
    expect(statusVerdict({ status: "pass", workspaceSha256: FP_A }, undefined)).toBe("green"); // outside a git repo: no current fingerprint
  });

  it("stale only when a stored fingerprint exists and differs from the current tree", () => {
    expect(statusVerdict({ status: "pass", workspaceSha256: FP_A }, FP_B)).toBe("stale");
  });

  it("red for non-pass receipts regardless of fingerprints", () => {
    for (const status of ["fail", "error", "skipped"] as const) {
      expect(statusVerdict({ status, workspaceSha256: FP_A }, FP_B)).toBe("red");
      expect(statusVerdict({ status }, undefined)).toBe("red");
    }
  });
});

describe("fingerprinted events round-trip through the store", () => {
  it("appends and re-validates a sensor_result event carrying workspaceSha256", async () => {
    const dir = await makeDir();
    await appendEvent(dir, {
      kind: "sensor_result",
      atUtc: "2026-01-01T00:00:00.000Z",
      actor: "cli",
      sensor: "format",
      status: "pass",
      exitCode: 0,
      durationMs: 1,
      workspaceSha256: FP_A,
    });
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.workspaceSha256).toBe(FP_A);
    expect(events[0]?.chainHash).toMatch(/^[0-9a-f]{64}$/u); // chain intact
  });
});
