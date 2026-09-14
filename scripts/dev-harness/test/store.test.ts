/**
 * dev-harness store tests (DSH-02): canonical JSON, sha-256 helper, append +
 * chain linkage, and corruption detection with line numbers. Uses temp state
 * dirs (node:fs/promises + os.tmpdir); no sensors are spawned.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVENTS_FILE,
  DevHarnessError,
  appendEvent,
  canonicalJson,
  readEvents,
  sha256Hex,
  type WorkflowEvent,
  type WorkflowEventBody,
} from "../index.js";

const ISO = "2026-01-01T00:00:00.000Z";

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "do-sift-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

function body(overrides: Partial<WorkflowEventBody> = {}): WorkflowEventBody {
  return { kind: "init", atUtc: ISO, actor: "test", ...overrides };
}

async function corruptionOf(fn: () => Promise<unknown>): Promise<DevHarnessError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DevHarnessError);
    return err as DevHarnessError;
  }
  throw new Error("expected the call to throw");
}

async function writeEvents(dir: string, events: readonly WorkflowEvent[]): Promise<void> {
  await writeFile(
    join(dir, EVENTS_FILE),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
}

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it("drops undefined object values and maps top-level undefined to null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("sha256Hex", () => {
  it("matches known sha-256 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("appendEvent + readEvents", () => {
  it("starts the chain with an empty prev hash and assigns seq 1", async () => {
    const dir = await makeDir();
    const b = body();
    const event = await appendEvent(dir, b);
    expect(event.seq).toBe(1);
    // Hash input = "" (no prev) + "|" + the event minus chainHash (seq included).
    expect(event.chainHash).toBe(sha256Hex(`|${canonicalJson({ ...b, seq: 1 })}`));
    // The state dir (here: a not-yet-existing subdir) is created on demand.
    const nested = await appendEvent(join(dir, "nested", "state"), b);
    expect(nested.seq).toBe(1);
    await expect(readFile(join(dir, "nested", "state", EVENTS_FILE), "utf8")).resolves.toContain(
      '"seq":1',
    );
  });

  it("chains subsequent events over prev hash + body with seq", async () => {
    const dir = await makeDir();
    const first = await appendEvent(dir, body());
    const b2 = body({
      kind: "sensor_result",
      sensor: "format",
      status: "pass",
      exitCode: 0,
      durationMs: 5,
    });
    const second = await appendEvent(dir, b2);
    expect(second.seq).toBe(2);
    expect(second.chainHash).toBe(
      sha256Hex(`${first.chainHash}|${canonicalJson({ ...b2, seq: 2 })}`),
    );
  });

  it("round-trips appended events through readEvents", async () => {
    const dir = await makeDir();
    const appended = [
      await appendEvent(dir, body()),
      await appendEvent(dir, body({ kind: "sensor_halted", sensor: "flaky", detail: "halted" })),
      await appendEvent(dir, body({ kind: "errors_cleared", sensor: "flaky" })),
    ];
    await expect(readEvents(dir)).resolves.toEqual(appended);
  });

  it("returns [] when the log file is missing", async () => {
    const dir = await makeDir();
    await expect(readEvents(dir)).resolves.toEqual([]);
  });

  it("rejects invalid event bodies as usage errors", async () => {
    const dir = await makeDir();
    try {
      await appendEvent(dir, body({ actor: "x".repeat(65) }));
      expect.unreachable("appendEvent should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DevHarnessError);
      expect((err as DevHarnessError).kind).toBe("usage");
    }
  });

  it("refuses to append to corrupted state", async () => {
    const dir = await makeDir();
    await appendEvent(dir, body());
    const raw = await readFile(join(dir, EVENTS_FILE), "utf8");
    await writeFile(join(dir, EVENTS_FILE), `${raw}${raw}`, "utf8"); // duplicate seq 1
    const err = await corruptionOf(() => appendEvent(dir, body()));
    expect(err.kind).toBe("state-corruption");
  });
});

describe("readEvents corruption detection", () => {
  it("reports the line number for a chain hash mismatch", async () => {
    const dir = await makeDir();
    await appendEvent(dir, body());
    await appendEvent(dir, body({ kind: "sensor_result", sensor: "format", status: "pass" }));
    const events = await readEvents(dir);
    await writeEvents(
      dir,
      events.map((e, i) => (i === 1 ? { ...e, chainHash: "f".repeat(64) } : e)),
    );
    const err = await corruptionOf(() => readEvents(dir));
    expect(err.kind).toBe("state-corruption");
    expect(err.message).toContain(":2:");
    expect(err.message).toContain("chain hash mismatch");
  });

  it("reports the line number for a tampered field (actor)", async () => {
    const dir = await makeDir();
    await appendEvent(dir, body());
    const events = await readEvents(dir);
    await writeEvents(
      dir,
      events.map((e, i) => (i === 0 ? { ...e, actor: "mallory" } : e)),
    );
    const err = await corruptionOf(() => readEvents(dir));
    expect(err.message).toContain(":1:");
    expect(err.message).toContain("chain hash mismatch");
  });

  it("reports a broken seq order", async () => {
    const dir = await makeDir();
    await appendEvent(dir, body());
    await appendEvent(dir, body({ kind: "sensor_result", sensor: "format", status: "pass" }));
    const events = await readEvents(dir);
    await writeEvents(
      dir,
      events.map((e, i) => (i === 1 ? { ...e, seq: 3 } : e)),
    );
    const err = await corruptionOf(() => readEvents(dir));
    expect(err.message).toContain(":2:");
    expect(err.message).toContain("expected seq 2, found 3");
  });

  it("reports an invalid JSON line", async () => {
    const dir = await makeDir();
    await appendEvent(dir, body());
    const raw = await readFile(join(dir, EVENTS_FILE), "utf8");
    await writeFile(join(dir, EVENTS_FILE), `${raw}not-json\n`, "utf8");
    const err = await corruptionOf(() => readEvents(dir));
    expect(err.message).toContain(":2:");
    expect(err.message).toContain("invalid event");
  });

  it("reports a blank interior line (but tolerates the trailing newline)", async () => {
    const dir = await makeDir();
    await appendEvent(dir, body());
    await appendEvent(dir, body({ kind: "errors_cleared" }));
    const raw = await readFile(join(dir, EVENTS_FILE), "utf8");
    await writeFile(join(dir, EVENTS_FILE), raw.replace("\n", "\n\n"), "utf8");
    const err = await corruptionOf(() => readEvents(dir));
    expect(err.message).toContain(":2:");
    expect(err.message).toContain("blank line");

    // The unmodified file — ending in "\n" — still reads cleanly.
    await writeFile(join(dir, EVENTS_FILE), raw, "utf8");
    await expect(readEvents(dir)).resolves.toHaveLength(2);
  });
});
