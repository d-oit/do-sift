/**
 * Dev-signal staleness tests (DSH-07, plan 010): the pure statusVerdict
 * matrix, signal-set input fingerprinting, line-ending normalization, set-isolated
 * invalidation, and fingerprint-stamped events round-tripping through the store.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  computeSetFingerprint,
  isSensorInput,
  parseEvidenceReceipt,
  readEvents,
  sha256Hex,
  statusVerdict,
} from "../index.js";

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

  it("red when receipt schemaVersion is unknown (not 1)", () => {
    expect(statusVerdict({ status: "pass", workspaceSha256: FP_A, schemaVersion: 99 }, FP_A)).toBe(
      "red",
    );
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

describe("isSensorInput filtering", () => {
  it("filters sensor inputs accurately and excludes .do-harness/", () => {
    expect(isSensorInput("format", ".do-harness/evidence.feedback.json")).toBe(false);
    expect(isSensorInput("format", "src/index.ts")).toBe(true);
    expect(isSensorInput("format", "evals/quality/test.json")).toBe(false);

    expect(isSensorInput("evals", "evals/quality/test.json")).toBe(true);
    expect(isSensorInput("evals", "src/index.ts")).toBe(false);

    expect(isSensorInput("release", "migrations/0001_init.sql")).toBe(true);
    expect(isSensorInput("release", "src/index.ts")).toBe(false);
  });
});

describe("computeSetFingerprint", () => {
  it("generates identical fingerprint across repeated runs over identical inputs", () => {
    const root = process.cwd();
    const fp1 = computeSetFingerprint("feedback", root);
    const fp2 = computeSetFingerprint("feedback", root);
    expect(fp1).toBeDefined();
    expect(fp1).toBe(fp2);
  });

  it("is stable across CRLF vs LF line endings", async () => {
    const repo = await makeDir();
    spawnSync("git", ["init"], { cwd: repo });
    await writeFile(join(repo, "package.json"), '{\n  "name": "demo"\n}\n');
    await writeFile(join(repo, "tsconfig.json"), '{\n  "compilerOptions": {}\n}\n');
    await mkdir(join(repo, "src"), { recursive: true });

    // LF file
    await writeFile(join(repo, "src", "index.ts"), "const x = 1;\nconsole.log(x);\n");
    spawnSync("git", ["add", "."], { cwd: repo });
    const fpLF = computeSetFingerprint("feedback", repo);

    // Convert to CRLF file
    await writeFile(join(repo, "src", "index.ts"), "const x = 1;\r\nconsole.log(x);\r\n");
    const fpCRLF = computeSetFingerprint("feedback", repo);

    expect(fpLF).toBeDefined();
    expect(fpLF).toBe(fpCRLF);
  });

  it("invalidates only affected signal sets when editing set-specific files", async () => {
    const repo = await makeDir();
    spawnSync("git", ["init"], { cwd: repo });
    await writeFile(join(repo, "package.json"), '{\n  "name": "demo"\n}\n');
    await writeFile(join(repo, "tsconfig.json"), '{\n  "compilerOptions": {}\n}\n');
    await writeFile(join(repo, "vitest.config.ts"), "export default {};\n");
    await mkdir(join(repo, "evals"), { recursive: true });
    await writeFile(join(repo, "evals", "fixture.json"), "{}\n");
    await mkdir(join(repo, "migrations"), { recursive: true });
    await writeFile(join(repo, "migrations", "0001_init.sql"), "CREATE TABLE x;\n");
    spawnSync("git", ["add", "."], { cwd: repo });

    const fb1 = computeSetFingerprint("feedback", repo);
    const ver1 = computeSetFingerprint("verification", repo);
    const rel1 = computeSetFingerprint("release", repo);

    // Edit evals fixture (only in verification & release)
    await writeFile(join(repo, "evals", "fixture.json"), '{"updated": true}\n');
    const fb2 = computeSetFingerprint("feedback", repo);
    const ver2 = computeSetFingerprint("verification", repo);
    const rel2 = computeSetFingerprint("release", repo);

    expect(fb2).toBe(fb1); // feedback set untouched!
    expect(ver2).not.toBe(ver1); // verification set invalidated!
    expect(rel2).not.toBe(rel1); // release set invalidated!

    // Edit migrations/0001_init.sql (only in release)
    await writeFile(join(repo, "migrations", "0001_init.sql"), "CREATE TABLE x (id INT);\n");
    const fb3 = computeSetFingerprint("feedback", repo);
    const ver3 = computeSetFingerprint("verification", repo);
    const rel3 = computeSetFingerprint("release", repo);

    expect(fb3).toBe(fb1); // feedback set untouched!
    expect(ver3).toBe(ver2); // verification set untouched by migration edit!
    expect(rel3).not.toBe(rel2); // release set invalidated!
  });

  it("is not affected by writes inside .do-harness/", async () => {
    const repo = await makeDir();
    spawnSync("git", ["init"], { cwd: repo });
    await writeFile(join(repo, "package.json"), '{\n  "name": "demo"\n}\n');
    await writeFile(join(repo, "tsconfig.json"), '{\n  "compilerOptions": {}\n}\n');
    spawnSync("git", ["add", "."], { cwd: repo });

    const fpBefore = computeSetFingerprint("feedback", repo);

    // Write a receipt file in .do-harness/
    await mkdir(join(repo, ".do-harness"), { recursive: true });
    await writeFile(join(repo, ".do-harness", "evidence.feedback.json"), "{}\n");

    const fpAfter = computeSetFingerprint("feedback", repo);
    expect(fpAfter).toBe(fpBefore);
  });
});

describe("parseEvidenceReceipt", () => {
  it("returns undefined for missing, corrupt, or unknown schema version files", async () => {
    const dir = await makeDir();
    const missing = parseEvidenceReceipt(join(dir, "evidence.feedback.json"));
    expect(missing).toBeUndefined();

    await writeFile(join(dir, "evidence.feedback.json"), "NOT_JSON");
    expect(parseEvidenceReceipt(join(dir, "evidence.feedback.json"))).toBeUndefined();

    await writeFile(
      join(dir, "evidence.feedback.json"),
      JSON.stringify({ schemaVersion: 99, set: "feedback" }),
    );
    expect(parseEvidenceReceipt(join(dir, "evidence.feedback.json"))).toBeUndefined();
  });
});
