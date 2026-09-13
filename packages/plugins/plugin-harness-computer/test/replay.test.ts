/**
 * CMP-02: tamper-checked replay + the no-remote-control export-surface
 * guard. Replay is consent-authoritative: the recorded log decides what
 * re-executes; denied actions are skipped; no prompt ever fires; a plan
 * that does not match its log is refused as tampered.
 */
import { describe, expect, it } from "vitest";
import type { HarnessRunLog, HarnessTask } from "@do-sift/contracts";
import * as exports from "../src/index.js";
import {
  ReplayError,
  replayComputerRun,
  type ComputerActionPlan,
  type DesktopDriver,
} from "../src/index.js";

function makeDriver() {
  const calls: string[] = [];
  return {
    calls,
    driver: {
      open: async (t: string) => {
        calls.push(`open:${t}`);
      },
      type: async (t: string) => {
        calls.push(`type:${t.length}`);
      },
      click: async (t: string) => {
        calls.push(`click:${t}`);
      },
      scroll: async (px: number) => {
        calls.push(`scroll:${px}`);
      },
      key: async (c: string) => {
        calls.push(`key:${c}`);
      },
      close: async () => {
        calls.push("close");
      },
    } satisfies DesktopDriver,
  };
}

function task(): HarnessTask {
  return {
    kind: "computer",
    ownerId: "owner-a",
    instruction: "replay fixture",
    limits: { deadlineMs: 60_000, maxActions: 10 },
  };
}

const PLAN: ComputerActionPlan = {
  actions: [
    { kind: "open", target: "notepad.exe" },
    { kind: "type", text: "hello" },
    { kind: "key", combo: "ctrl+s" },
  ],
};

/** A recorded run: open allowed, type allowed, key denied. */
function recordedLog(): HarnessRunLog {
  return {
    task: task(),
    actions: [
      { seq: 0, type: "open", detail: "notepad.exe", allowed: true },
      { seq: 1, type: "type", detail: "5 chars @ 60ms/keystroke", allowed: true },
      { seq: 2, type: "key", detail: "ctrl+s", allowed: false, deniedBy: "consent:key" },
    ],
    outcome: "denied",
  };
}

describe("replay (CMP-02, consent-authoritative)", () => {
  it("re-executes allowed actions in order and skips denied ones", async () => {
    const { driver, calls } = makeDriver();
    const outcome = await replayComputerRun({ log: recordedLog(), plan: PLAN, driver });
    expect(outcome).toMatchObject({ executed: 2, skipped: 1, outcome: "denied" });
    expect(calls).toEqual(["open:notepad.exe", "type:5"]); // key NEVER re-attempted
  });

  it("never prompts: consent comes from the log, not a live approver", async () => {
    const { driver } = makeDriver();
    // a prompt that would explode if replay consulted it
    const hostilePrompt = {
      ask: async () => {
        throw new Error("replay must not prompt");
      },
    };
    void hostilePrompt;
    // no consent parameter exists on replayComputerRun at all — structural proof
    const outcome = await replayComputerRun({ log: recordedLog(), plan: PLAN, driver });
    expect(outcome.executed).toBe(2);
  });

  it("refuses a tampered plan: extra, missing, or reordered actions", async () => {
    const { driver } = makeDriver();
    const extra = { actions: [...PLAN.actions, { kind: "key" as const, combo: "rm -rf" }] };
    await expect(
      replayComputerRun({ log: recordedLog(), plan: extra, driver }),
    ).rejects.toBeInstanceOf(ReplayError);

    const missing = { actions: PLAN.actions.slice(0, 2) };
    await expect(replayComputerRun({ log: recordedLog(), plan: missing, driver })).rejects.toThrow(
      /mismatch/,
    );

    const reordered = {
      actions: [PLAN.actions[1], PLAN.actions[0], PLAN.actions[2]] as ComputerActionPlan["actions"],
    };
    await expect(
      replayComputerRun({ log: recordedLog(), plan: reordered, driver }),
    ).rejects.toThrow(/mismatch at action 0/);
  });

  it("a type action with different pacing detail still replays (detail is not identity)", async () => {
    const { driver } = makeDriver();
    const log = recordedLog();
    log.actions[1] = { seq: 1, type: "type", detail: "5 chars @ 200ms/keystroke", allowed: true };
    const outcome = await replayComputerRun({ log, plan: PLAN, driver });
    expect(outcome.executed).toBe(2);
  });
});

describe("no remote control surface (CMP-02)", () => {
  it("the export surface contains only local, non-binding names", () => {
    const names = Object.keys(exports).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "ConsentLedger",
        "createComputerHarness",
        "ReplayError",
        "replayComputerRun",
      ]),
    );
    for (const banned of ["listen", "serve", "bind", "connect", "createServer", "expose"]) {
      expect(
        names.some((n) => n.toLowerCase().includes(banned)),
        `export resembling "${banned}"`,
      ).toBe(false);
    }
  });
});
