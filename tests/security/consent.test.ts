/**
 * Consolidated consent-bypass negatives (CMP-03): every attempt to get
 * computer automation past its consent gates, composed across kernel +
 * harness layers. Per-layer suites (plugin-harness-computer) prove the
 * mechanisms; these prove the bypasses fail closed end to end.
 */
import { describe, expect, it } from "vitest";
import type { HarnessTask } from "@do-sift/contracts";
import { CapabilityError, Kernel } from "@do-sift/kernel";
import harnessJson from "../../packages/plugins/plugin-harness-computer/plugin.json" with { type: "json" };
import {
  createComputerHarness,
  type ComputerHarnessInstance,
  type ConsentPrompt,
  type DesktopDriver,
} from "@do-sift/plugin-harness-computer";

function task(): HarnessTask {
  return {
    kind: "computer",
    ownerId: "owner-a",
    instruction: "bypass fixture",
    limits: { deadlineMs: 60_000, maxActions: 10 },
  };
}

const PLAN = {
  actions: [{ kind: "open" as const, target: "notepad.exe" }],
};

function makeDriver() {
  const calls: string[] = [];
  return {
    calls,
    driver: {
      open: async (t: string) => {
        calls.push(`open:${t}`);
      },
      type: async () => {},
      click: async () => {},
      scroll: async () => {},
      key: async () => {},
      close: async () => {},
    } satisfies DesktopDriver,
  };
}

async function activated(
  driver: DesktopDriver,
  consent: ConsentPrompt | undefined,
  config: Record<string, unknown>,
): Promise<ComputerHarnessInstance> {
  const instance = createComputerHarness({ driver, consent });
  await instance.activate({
    pluginName: "harness-computer",
    config,
    events: { emit: () => {} },
  } as unknown as Parameters<ComputerHarnessInstance["activate"]>[0]);
  return instance;
}

describe("consent-bypass attempts (CMP-03, fail closed)", () => {
  it("the enabled flag accepts no substitute for the exact boolean true", async () => {
    const { driver } = makeDriver();
    for (const enabled of ["yes", "true", 1, {}, null]) {
      await expect(activated(driver, undefined, { enabled }), String(enabled)).rejects.toThrow(
        /disabled by default/,
      );
    }
  });

  it("secret-shaped config keys are refused outright (keychain-only rule)", async () => {
    const { driver } = makeDriver();
    for (const key of ["password", "api_key", "myToken", "credential", "private-key"]) {
      await expect(
        activated(driver, undefined, { enabled: true, [key]: "hunter2" }),
        key,
      ).rejects.toThrow(/keychain/);
    }
  });

  it("the kernel grant is required, and ci refuses even with a grant", async () => {
    const { driver } = makeDriver();
    const manifest = { ...harnessJson, config: { ...harnessJson.config, enabled: true } };
    const local = new Kernel("local");
    local.register(manifest, () => createComputerHarness({ driver }));
    await expect(local.activate("harness-computer")).rejects.toBeInstanceOf(CapabilityError);
    local.grant("computer");
    await expect(local.activate("harness-computer")).resolves.toBeUndefined();

    const ci = new Kernel("ci");
    ci.register(manifest, () => createComputerHarness({ driver }));
    ci.grant("computer");
    await expect(ci.activate("harness-computer")).rejects.toThrow(/cannot activate in ci/);
  });

  it("a crashing consent prompt denies instead of escaping the run", async () => {
    const { driver, calls } = makeDriver();
    const crashing: ConsentPrompt = {
      ask: async () => {
        throw new Error("UI thread died");
      },
    };
    const instance = await activated(driver, crashing, { enabled: true });
    const runLog = await instance.run(task(), PLAN);
    expect(runLog.outcome).toBe("denied");
    expect(runLog.actions[0]).toMatchObject({ allowed: false, deniedBy: "consent:open" });
    expect(calls).toEqual([]); // nothing executed
    // the denial is recorded (replay authority intact)
    expect(instance.consentLedger()).toHaveLength(1);
  });

  it("garbage verdicts (truthy non-boolean allowed) deny", async () => {
    const { driver, calls } = makeDriver();
    const garbage: ConsentPrompt = {
      // deliberately lying about the type: runtime shape is what matters
      ask: async () =>
        ({ allowed: "yes", rememberClass: true }) as unknown as {
          allowed: boolean;
          rememberClass: boolean;
        },
    };
    const instance = await activated(driver, garbage, { enabled: true });
    const runLog = await instance.run(task(), PLAN);
    expect(runLog.outcome).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("no prompt wired denies everything; the ledger cannot be rewritten from outside", async () => {
    const { driver, calls } = makeDriver();
    const instance = await activated(driver, undefined, { enabled: true });
    const runLog = await instance.run(task(), PLAN);
    expect(runLog.outcome).toBe("denied");
    expect(calls).toEqual([]);

    // mutating the exported ledger copy must not change remembered verdicts
    const snapshot = instance.consentLedger() as Array<{ allowed: boolean }>;
    snapshot.push({ actionClass: "open", allowed: true, remembered: true, decidedAt: "now" });
    const second = await instance.run(task(), PLAN);
    expect(second.outcome).toBe("denied"); // still denied: the real ledger was untouched
    expect(second.actions[0]?.allowed).toBe(false);
  });
});
