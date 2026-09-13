import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import policyJson from "../plugin.json" with { type: "json" };
import {
  SiteAccessDeniedError,
  createSiteAccessPolicy,
  type SiteAccessInstance,
} from "../src/index.js";

async function activated(
  configOverrides: Record<string, unknown> = {},
): Promise<SiteAccessInstance> {
  const plugin = createSiteAccessPolicy();
  await plugin.activate({
    pluginName: "policy-siteaccess",
    config: configOverrides,
    events: { emit: () => {} },
  } as unknown as Parameters<SiteAccessInstance["activate"]>[0]);
  return plugin;
}

const REGISTRY = {
  sitePolicies: [
    {
      host: "strictly-denied.test",
      robotsAccess: "deny",
      tosAutomated: "unspecified",
      checkedAt: "2026-09-11",
    },
    {
      host: "tos-denied.test",
      robotsAccess: "unspecified",
      tosAutomated: "automated-denied",
      checkedAt: "2026-09-11",
    },
    {
      host: "friendly.test",
      robotsAccess: "allow",
      tosAutomated: "automated-ok",
      checkedAt: "2026-09-11",
    },
  ],
};

describe("layered decisions (fail closed)", () => {
  it("layer 1: shipped default-deny wins over everything", async () => {
    const plugin = await activated({
      ...REGISTRY,
      allowlist: ["linkedin.com"],
      denylist: [],
    });
    // even allowlisting linkedin.com cannot override the shipped deny list
    expect(plugin.check("linkedin.com")).toMatchObject({ allowed: false, source: "default-deny" });
    expect(plugin.check("www.linkedin.com")).toMatchObject({
      allowed: false,
      source: "default-deny",
    });
    expect(plugin.assertAllowed.bind(plugin, "linkedin.com")).toThrow(SiteAccessDeniedError);
  });

  it("layer 2: registry denies for robots and ToS, with the check date in the reason", async () => {
    const plugin = await activated(REGISTRY);
    expect(plugin.check("strictly-denied.test")).toMatchObject({
      allowed: false,
      source: "registry",
    });
    expect(plugin.check("www.tos-denied.test")).toMatchObject({
      allowed: false,
      source: "registry",
      reason: expect.stringContaining("2026-09-11"),
    });
    // registered-and-friendly falls through to the default layer
    expect(plugin.check("friendly.test")).toMatchObject({ allowed: true, source: "default" });
  });

  it("layer 3: operator denylist applies below the registry", async () => {
    const plugin = await activated({ ...REGISTRY, denylist: ["noisy.test"] });
    expect(plugin.check("noisy.test")).toMatchObject({ allowed: false, source: "denylist" });
    expect(plugin.check("sub.noisy.test")).toMatchObject({ allowed: false, source: "denylist" });
  });

  it("layer 4: a non-empty allowlist is exhaustive", async () => {
    const plugin = await activated({ ...REGISTRY, allowlist: ["friendly.test", "allowed.test"] });
    expect(plugin.check("allowed.test")).toMatchObject({ allowed: true, source: "allowlist" });
    expect(plugin.check("sub.allowed.test")).toMatchObject({ allowed: true, source: "allowlist" });
    expect(plugin.check("other.test")).toMatchObject({
      allowed: false,
      source: "allowlist",
      reason: "host is not allowlisted",
    });
  });

  it("layer 5: requireRegistry denies unregistered hosts (strict mode)", async () => {
    const strict = await activated({ ...REGISTRY, requireRegistry: true });
    expect(strict.check("friendly.test")).toMatchObject({ allowed: true, source: "default" });
    expect(strict.check("unregistered.test")).toMatchObject({
      allowed: false,
      source: "require-registry",
    });

    const lax = await activated(REGISTRY);
    expect(lax.check("unregistered.test")).toMatchObject({ allowed: true, source: "default" });
  });

  it("fails closed on empty hosts and before activation", async () => {
    const plugin = await activated();
    expect(plugin.check("")).toMatchObject({ allowed: false, reason: "empty host" });
    expect(() => createSiteAccessPolicy().check("example.test")).toThrow(/not activated/);
  });

  it("refuses registry entries without a checked date or valid posture values", async () => {
    await expect(
      activated({
        sitePolicies: [{ host: "x.test", robotsAccess: "allow", tosAutomated: "unspecified" }],
      }),
    ).rejects.toThrow(/checkedAt/);
    await expect(
      activated({
        sitePolicies: [
          {
            host: "x.test",
            robotsAccess: "sometimes",
            tosAutomated: "unspecified",
            checkedAt: "2026-09-11",
          },
        ],
      }),
    ).rejects.toThrow(/invalid site policy/);
  });
});

describe("zero-capability proof + kernel round-trip", () => {
  it("declares no capabilities (pure config decisions)", async () => {
    expect(policyJson.capabilities).toEqual([]);
    expect(policyJson.kind).toBe("policy");
  });

  it("registers, activates, decides, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: SiteAccessInstance | undefined;
    kernel.register({ ...policyJson, config: REGISTRY }, () => {
      instance = createSiteAccessPolicy();
      return instance;
    });
    await kernel.activate("policy-siteaccess");
    expect(instance?.check("linkedin.com").allowed).toBe(false);
    await kernel.deactivate("policy-siteaccess");
    expect(() => instance?.check("example.test")).toThrow(/not activated/);
  });
});
