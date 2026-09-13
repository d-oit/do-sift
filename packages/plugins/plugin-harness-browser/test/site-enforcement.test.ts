/**
 * BRW-02 end-to-end enforcement: the browser harness wired to the REAL
 * CORE-08 site-access policy (layered: shipped default-deny → robots/ToS
 * registry → allow/deny lists → requireRegistry strict mode). Proves ADR
 * 0005's "bot-prohibiting sites default-deny" through a full harness run:
 * every navigation is a policy decision, and denied hosts never reach the
 * driver.
 */
import { describe, expect, it } from "vitest";
import type { HarnessTask } from "@do-sift/contracts";
import { createSiteAccessPolicy, type SiteAccessInstance } from "@do-sift/plugin-policy-siteaccess";
import {
  createBrowserHarness,
  type BrowserDriver,
  type BrowserHarnessInstance,
} from "../src/index.js";

function task(): HarnessTask {
  return {
    kind: "browser",
    ownerId: "owner-a",
    instruction: "site enforcement fixture",
    limits: { deadlineMs: 60_000, maxActions: 10 },
  };
}

async function strictPolicy(config: Record<string, unknown> = {}): Promise<SiteAccessInstance> {
  const policy = createSiteAccessPolicy();
  await policy.activate({
    pluginName: "policy-siteaccess",
    config: { requireRegistry: true, ...config },
    events: { emit: () => {} },
  } as unknown as Parameters<SiteAccessInstance["activate"]>[0]);
  return policy;
}

function makeDriver() {
  const navigated: string[] = [];
  return {
    navigated,
    driver: {
      navigate: async (url: string) => {
        navigated.push(url);
      },
      scrollBy: async () => {},
      type: async () => {},
      click: async () => {},
      close: async () => {},
    } satisfies BrowserDriver,
  };
}

async function harness(policy: SiteAccessInstance): Promise<BrowserHarnessInstance> {
  const { driver } = makeDriver();
  const instance = createBrowserHarness({
    driver,
    sitePolicy: policy, // the CORE-08 plugin satisfies the gate structurally
    now: () => Date.now(),
    sleep: async () => {},
  });
  await instance.activate({
    pluginName: "harness-browser",
    config: {},
    events: { emit: () => {} },
  } as unknown as Parameters<BrowserHarnessInstance["activate"]>[0]);
  return instance;
}

// the dated robots/ToS registry a real deployment would keep
const REGISTRY = {
  sitePolicies: [
    {
      host: "example.test",
      robotsAccess: "allow",
      tosAutomated: "automated-ok",
      checkedAt: "2026-09-11",
    },
    {
      host: "robots-denied.test",
      robotsAccess: "deny",
      tosAutomated: "unspecified",
      checkedAt: "2026-09-11",
    },
    {
      host: "tos-denied.test",
      robotsAccess: "allow",
      tosAutomated: "automated-denied",
      checkedAt: "2026-09-11",
    },
  ],
};

describe("site-access enforcement on every navigation (BRW-02)", () => {
  it("runs registered, approved hosts; refuses every other layer", async () => {
    const policy = await strictPolicy(REGISTRY);
    const instance = await harness(policy);

    // registered + approved → runs
    const ok = await instance.run(task(), {
      actions: [{ kind: "navigate", url: "https://example.test/page" }],
    });
    expect(ok.outcome).toBe("completed");

    // robots deny (layer 2)
    const robots = await instance.run(task(), {
      actions: [{ kind: "navigate", url: "https://robots-denied.test/page" }],
    });
    expect(robots.outcome).toBe("denied");
    expect(robots.actions[0]).toMatchObject({
      allowed: false,
      deniedBy: expect.stringContaining("robots"),
    });

    // ToS deny (layer 2) — even with robots "allow"
    const tos = await instance.run(task(), {
      actions: [{ kind: "navigate", url: "https://tos-denied.test/page" }],
    });
    expect(tos.outcome).toBe("denied");
    expect(tos.actions[0]).toMatchObject({ deniedBy: expect.stringContaining("ToS") });

    // shipped default-deny (layer 1) — linkedin.com is not even in the registry
    const linkedin = await instance.run(task(), {
      actions: [{ kind: "navigate", url: "https://www.linkedin.com/lure" }],
    });
    expect(linkedin.outcome).toBe("denied");
    expect(linkedin.actions[0]).toMatchObject({
      deniedBy: expect.stringContaining("default-deny"),
    });

    // unregistered host (layer 5, strict mode)
    const stray = await instance.run(task(), {
      actions: [{ kind: "navigate", url: "https://unregistered.test/page" }],
    });
    expect(stray.outcome).toBe("denied");
    expect(stray.actions[0]).toMatchObject({ deniedBy: expect.stringContaining("registry") });
  });

  it("stops the plan at the first denied navigation (no further actions run)", async () => {
    const policy = await strictPolicy(REGISTRY);
    const { navigated, driver } = makeDriver();
    const instance = createBrowserHarness({
      driver,
      sitePolicy: policy,
      now: () => Date.now(),
      sleep: async () => {},
    });
    await instance.activate({
      pluginName: "harness-browser",
      config: {},
      events: { emit: () => {} },
    } as unknown as Parameters<BrowserHarnessInstance["activate"]>[0]);

    const runLog = await instance.run(task(), {
      actions: [
        { kind: "navigate", url: "https://example.test/one" },
        { kind: "navigate", url: "https://robots-denied.test/two" },
        { kind: "navigate", url: "https://example.test/three" }, // never reached
      ],
    });
    expect(runLog.outcome).toBe("denied");
    expect(navigated).toEqual(["https://example.test/one"]);
    expect(runLog.actions).toHaveLength(2);
  });

  it("the deny list survives subdomain, port, and trailing-dot variants", async () => {
    const policy = await strictPolicy({
      sitePolicies: [
        {
          host: "www.linkedin.com",
          robotsAccess: "allow",
          tosAutomated: "automated-ok",
          checkedAt: "2026-09-11",
        },
      ],
    });
    // even a registry entry allowlisting www.linkedin.com cannot beat layer 1
    for (const host of ["www.linkedin.com", "linkedin.com:443", "linkedin.com."]) {
      const verdict = policy.check(host);
      expect(verdict.allowed, host).toBe(false);
      expect(verdict.source, host).toBe("default-deny");
    }
  });
});
