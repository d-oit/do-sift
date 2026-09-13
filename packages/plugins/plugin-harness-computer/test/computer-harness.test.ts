import { describe, expect, it } from "vitest";
import type { HarnessTask } from "@do-sift/contracts";
import { CapabilityError, Kernel } from "@do-sift/kernel";
import harnessJson from "../plugin.json" with { type: "json" };
import {
  createComputerHarness,
  type ComputerActionPlan,
  type ComputerHarnessInstance,
  type ConsentDecision,
  type ConsentPrompt,
  type DesktopDriver,
} from "../src/index.js";

function task(): HarnessTask {
  return {
    kind: "computer",
    ownerId: "owner-a",
    instruction: "consent fixture",
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

/** Scripted approver: one verdict per ask, in order. */
function scriptedPrompt(verdicts: Array<ConsentDecision>): {
  prompt: ConsentPrompt;
  asks: string[];
} {
  const asks: string[] = [];
  let i = 0;
  return {
    asks,
    prompt: {
      ask: async (actionClass) => {
        asks.push(actionClass);
        const v = verdicts[i++];
        if (v === undefined) throw new Error("unexpected extra consent ask");
        return v;
      },
    },
  };
}

async function harness(
  driver: DesktopDriver,
  consent: ConsentPrompt | undefined,
  config: Record<string, unknown> = { enabled: true },
): Promise<ComputerHarnessInstance> {
  const instance = createComputerHarness({
    driver,
    consent,
    now: () => Date.now(),
    sleep: async () => {},
  });
  await instance.activate({
    pluginName: "harness-computer",
    config,
    events: { emit: () => {} },
  } as unknown as Parameters<ComputerHarnessInstance["activate"]>[0]);
  return instance;
}

describe("default off + kernel grant gate (INV-003)", () => {
  it("refuses activation unless config.enabled is exactly true", async () => {
    const { driver } = makeDriver();
    const off = createComputerHarness({ driver });
    await expect(
      off.activate({
        pluginName: "harness-computer",
        config: {},
        events: { emit: () => {} },
      } as unknown as Parameters<ComputerHarnessInstance["activate"]>[0]),
    ).rejects.toThrow(/disabled by default/);
    await expect(
      off.activate({
        pluginName: "harness-computer",
        config: { enabled: "yes" },
        events: { emit: () => {} },
      } as unknown as Parameters<ComputerHarnessInstance["activate"]>[0]),
    ).rejects.toThrow(/disabled by default/);
  });

  it("the kernel refuses the computer capability without a grant and outright in ci", async () => {
    const { driver } = makeDriver();
    const factory = () => createComputerHarness({ driver });
    // enabled=true here isolates the KERNEL gate; the default-off gate has its own test above
    const manifest = { ...harnessJson, config: { ...harnessJson.config, enabled: true } };
    const local = new Kernel("local");
    local.register(manifest, factory);
    await expect(local.activate("harness-computer")).rejects.toBeInstanceOf(CapabilityError);
    local.grant("computer");
    await expect(local.activate("harness-computer")).resolves.toBeUndefined();
    await local.deactivate("harness-computer");

    const ci = new Kernel("ci");
    ci.register(harnessJson, factory);
    ci.grant("computer");
    await expect(ci.activate("harness-computer")).rejects.toThrow(/cannot activate in ci/);
  });
});

describe("per-class consent (CMP-01)", () => {
  it("asks once per class, runs approved actions, and remembers within the run", async () => {
    const { driver, calls } = makeDriver();
    const { prompt, asks } = scriptedPrompt([
      { allowed: true, rememberClass: true }, // open
      { allowed: true, rememberClass: true }, // type
      { allowed: true, rememberClass: true }, // key
    ]);
    const instance = await harness(driver, prompt);
    const runLog = await instance.run(task(), PLAN);
    expect(runLog.outcome).toBe("completed");
    expect(calls).toEqual(["open:notepad.exe", "type:5", "key:ctrl+s"]);
    // exactly one ask per class — remembered for the rest of the run
    expect(asks).toEqual(["open", "type", "key"]);
    expect(instance.consentLedger()).toHaveLength(3);
  });

  it("a remembered deny never prompts again and denies later actions", async () => {
    const { driver, calls } = makeDriver();
    const denyKeyRemembered = scriptedPrompt([{ allowed: false, rememberClass: true }]);
    const instance = await harness(driver, denyKeyRemembered.prompt);
    const first = await instance.run(task(), { actions: [{ kind: "key", combo: "alt+f4" }] });
    expect(first.outcome).toBe("denied");
    const second = await instance.run(task(), { actions: [{ kind: "key", combo: "ctrl+c" }] });
    expect(second.outcome).toBe("denied");
    expect(denyKeyRemembered.asks).toEqual(["key"]); // asked once, remembered
    expect(calls).not.toContain("key:alt+f4");
  });

  it("a non-remembered verdict asks again on the next action of the class", async () => {
    const { driver } = makeDriver();
    const oneShot = scriptedPrompt([
      { allowed: true, rememberClass: false },
      { allowed: true, rememberClass: false },
    ]);
    const instance = await harness(driver, oneShot.prompt);
    const runLog = await instance.run(task(), {
      actions: [
        { kind: "click", target: "button-a" },
        { kind: "click", target: "button-b" },
      ],
    });
    expect(runLog.outcome).toBe("completed");
    expect(oneShot.asks).toEqual(["click", "click"]);
  });

  it("fails closed with no consent prompt wired", async () => {
    const { driver, calls } = makeDriver();
    const instance = await harness(driver, undefined);
    const runLog = await instance.run(task(), PLAN);
    expect(runLog.outcome).toBe("denied");
    expect(runLog.actions[0]).toMatchObject({ allowed: false, deniedBy: "consent:open" });
    expect(calls).toEqual([]); // nothing executed
  });

  it("refuses to run before activation", async () => {
    const { driver } = makeDriver();
    const instance = createComputerHarness({ driver });
    await expect(instance.run(task(), PLAN)).rejects.toThrow(/not activated/);
  });
});
