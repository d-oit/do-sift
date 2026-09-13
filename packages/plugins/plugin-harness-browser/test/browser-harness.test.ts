import { describe, expect, it } from "vitest";
import { HarnessRunLog, type HarnessTask } from "@do-sift/contracts";
import { Kernel } from "@do-sift/kernel";
import harnessJson from "../plugin.json" with { type: "json" };
import {
  createBrowserHarness,
  type BrowserActionPlan,
  type BrowserDriver,
  type BrowserHarnessInstance,
  type SiteAccessGate,
} from "../src/index.js";

function task(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    kind: "browser",
    ownerId: "owner-a",
    instruction: "research task fixture",
    limits: { deadlineMs: 60_000, maxActions: 10 },
    ...overrides,
  } as HarnessTask;
}

interface DriverLog {
  navigated: string[];
  scrolled: number[];
  typed: Array<{ selector: string; text: string; perKeystrokeMs: number }>;
  clicked: string[];
  closed: number;
}

function makeDriver(): { driver: BrowserDriver; log: DriverLog } {
  const log: DriverLog = { navigated: [], scrolled: [], typed: [], clicked: [], closed: 0 };
  return {
    log,
    driver: {
      navigate: async (url) => {
        log.navigated.push(url);
      },
      scrollBy: async (px) => {
        log.scrolled.push(px);
      },
      type: async (selector, text, perKeystrokeMs) => {
        log.typed.push({ selector, text, perKeystrokeMs });
      },
      click: async (selector) => {
        log.clicked.push(selector);
      },
      close: async () => {
        log.closed++;
      },
    },
  };
}

function permissiveGate(): SiteAccessGate {
  return { assertAllowed: () => {} };
}

function denyingGate(hosts: string[]): SiteAccessGate {
  return {
    assertAllowed: (host) => {
      if (hosts.includes(host)) throw new Error(`site access denied for ${host}: default-deny`);
    },
  };
}

/** Records every pacing request instead of waiting — deterministic. */
function makeClock() {
  const sleeps: number[] = [];
  let t = 1_000_000;
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const PLAN: BrowserActionPlan = {
  actions: [
    { kind: "navigate", url: "https://example.test/search" },
    { kind: "type", selector: "#q", text: "hello" },
    { kind: "click", selector: "#submit" },
    { kind: "scroll", px: 800 },
    { kind: "scroll" }, // default step
  ],
};

function makeHarness(
  driver: BrowserDriver,
  gate: SiteAccessGate,
  clock: ReturnType<typeof makeClock>,
  config: Record<string, unknown> = {},
): BrowserHarnessInstance {
  const instance = createBrowserHarness({
    driver,
    sitePolicy: gate,
    now: clock.now,
    sleep: clock.sleep,
  });
  void instance.activate({
    pluginName: "harness-browser",
    config,
    events: { emit: () => {} },
  } as unknown as Parameters<BrowserHarnessInstance["activate"]>[0]);
  return instance;
}

describe("paced action layer (BRW-01)", () => {
  it("executes the plan in order, pacing between actions and typing slowly", async () => {
    const { driver, log } = makeDriver();
    const clock = makeClock();
    const harness = makeHarness(driver, permissiveGate(), clock);
    const runLog = await harness.run(task(), PLAN);

    expect(runLog.outcome).toBe("completed");
    expect(log.navigated).toEqual(["https://example.test/search"]);
    expect(log.typed).toEqual([{ selector: "#q", text: "hello", perKeystrokeMs: 60 }]);
    expect(log.clicked).toEqual(["#submit"]);
    expect(log.scrolled).toEqual([800, 600]); // explicit px then default step

    // pacing: action delay between each of the 5 actions, scroll pause after each scroll
    expect(clock.sleeps).toEqual([750, 750, 750, 400, 750, 400]);
    // all actions logged in order with seq
    expect(runLog.actions.map((a) => `${a.seq}:${a.type}:${a.allowed}`)).toEqual([
      "0:navigate:true",
      "1:type:true",
      "2:click:true",
      "3:scroll:true",
      "4:scroll:true",
    ]);
    // typed input detail records the gentleness rate
    expect(runLog.actions[1]?.detail).toContain("60ms/keystroke");
  });

  it("denies navigation to policy-refused hosts without touching the driver", async () => {
    const { driver, log } = makeDriver();
    const clock = makeClock();
    const harness = makeHarness(driver, denyingGate(["www.linkedin.com"]), clock);
    const runLog = await harness.run(task(), {
      actions: [{ kind: "navigate", url: "https://example.test/ok" }],
    });
    expect(runLog.outcome).toBe("completed");
    expect(log.navigated).toEqual(["https://example.test/ok"]);

    const denied = await harness.run(task(), {
      actions: [{ kind: "navigate", url: "https://www.linkedin.com/lure" }],
    });
    expect(denied.outcome).toBe("denied");
    expect(denied.actions[0]).toMatchObject({
      type: "navigate",
      allowed: false,
      deniedBy: expect.stringContaining("site-access"),
    });
    expect(log.navigated).toHaveLength(1); // the lure was never loaded
  });

  it("truncates the plan at maxActions", async () => {
    const { driver } = makeDriver();
    const clock = makeClock();
    const harness = makeHarness(driver, permissiveGate(), clock);
    const runLog = await harness.run(task({ limits: { deadlineMs: 60_000, maxActions: 2 } }), PLAN);
    expect(runLog.actions).toHaveLength(2);
    expect(runLog.actions[1]?.type).toBe("type");
  });

  it("stops with outcome timeout when the deadline passes", async () => {
    const { driver, log } = makeDriver();
    // clock that expires after 2 actions
    let t = 1_000_000;
    const sleeps: number[] = [];
    const clock = {
      now: () => t,
      sleeps,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
    const harness = makeHarness(driver, permissiveGate(), clock, { actionDelayMs: 10_000 });
    const runLog = await harness.run(
      task({ limits: { deadlineMs: 25_000, maxActions: 10 } }),
      PLAN,
    );
    expect(runLog.outcome).toBe("timeout");
    expect(log.navigated).toHaveLength(1);
    expect(log.typed).toHaveLength(1);
    expect(log.clicked).toHaveLength(1); // click at +20s fits the 25s deadline; scroll at +30s does not
  });

  it("closes the driver on deactivate and refuses runs before activation", async () => {
    const { driver, log } = makeDriver();
    const clock = makeClock();
    const instance = createBrowserHarness({
      driver,
      sitePolicy: permissiveGate(),
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(instance.run(task(), PLAN)).rejects.toThrow(/not activated/);
    void instance.activate({
      pluginName: "harness-browser",
      config: {},
      events: { emit: () => {} },
    } as unknown as Parameters<BrowserHarnessInstance["activate"]>[0]);
    await instance.deactivate();
    expect(log.closed).toBe(1);
  });

  it("validates the run log against the HarnessRunLog contract", async () => {
    const { driver } = makeDriver();
    const clock = makeClock();
    const harness = makeHarness(driver, permissiveGate(), clock);
    const runLog = await harness.run(task(), PLAN);
    expect(HarnessRunLog.parse(runLog)).toEqual(runLog);
  });
});

describe("capability + kernel round-trip", () => {
  it("declares exactly the browser capability (ADR 0005 scope)", () => {
    expect(harnessJson.capabilities).toEqual(["browser"]);
    expect(harnessJson.kind).toBe("harness");
  });

  it("registers, activates, runs, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    const { driver, log } = makeDriver();
    let instance: BrowserHarnessInstance | undefined;
    kernel.register(harnessJson, () => {
      instance = createBrowserHarness({
        driver,
        sitePolicy: permissiveGate(),
        now: () => 0,
        sleep: async () => {},
      });
      return instance;
    });
    await kernel.activate("harness-browser");
    const runLog = await instance?.run(task(), {
      actions: [{ kind: "navigate", url: "https://example.test/" }],
    });
    expect(runLog?.actions).toHaveLength(1);
    await kernel.deactivate("harness-browser");
    expect(log.closed).toBe(1);
  });
});
