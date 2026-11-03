/**
 * Declarative ethical guardrails (issue #124, ADR 0005).
 *
 * Proves the policy document is the single reviewable source of the shipped
 * guardrails, that the evaluator fails closed (default-deny, prohibited
 * stealth/CAPTCHA classes, grant and consent requirements, LinkedIn), that
 * weakening a policy is rejected, and that the kernel/harnesses actually
 * consult the engine for browser and computer actions.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_SITES,
  GuardrailError,
  SHIPPED_GUARDRAILS,
  assertGuardrailsIntegrity,
  createGuardrailEngine,
} from "@do-sift/contracts";
import { Kernel, type PluginContext } from "@do-sift/kernel";
import { createBrowserHarness, type BrowserDriver } from "@do-sift/plugin-harness-browser";
import { createComputerHarness, type DesktopDriver } from "@do-sift/plugin-harness-computer";

const engine = createGuardrailEngine(SHIPPED_GUARDRAILS, { granted: true });

describe("guardrails policy document (issue #124)", () => {
  it("is a standalone, auditable document tied to ADR 0005", () => {
    expect(SHIPPED_GUARDRAILS.schemaVersion).toBe("1");
    expect(SHIPPED_GUARDRAILS.defaultDecision).toBe("deny");
    expect(SHIPPED_GUARDRAILS.authority.adr).toBe("0005");
    expect(SHIPPED_GUARDRAILS.authority.invariants).toEqual(
      expect.arrayContaining(["INV-003", "INV-004", "INV-007"]),
    );
    expect(Object.keys(SHIPPED_GUARDRAILS.prohibited)).toEqual(
      expect.arrayContaining(["stealth", "captcha"]),
    );
  });

  it("keeps the shipped default-deny list in sync with the contracts (INV-007)", () => {
    const fromPolicy = SHIPPED_GUARDRAILS.siteAccess.defaultDenySites
      .map((site) => site.trim().toLowerCase())
      .sort();
    const fromContracts = [...DEFAULT_DENY_SITES].map((site) => site.toLowerCase()).sort();
    expect(fromPolicy).toEqual(fromContracts);
    expect(fromPolicy).toContain("linkedin.com");
  });
});

describe("guardrails evaluator (default-deny)", () => {
  it("allows ordinary browser and computer actions", () => {
    expect(
      engine.check({ capability: "browser", action: "navigate", host: "example.com" }),
    ).toMatchObject({ decision: "allow", rule: "permitted" });
    expect(engine.check({ capability: "computer", action: "type", consent: true })).toMatchObject({
      decision: "allow",
    });
  });

  it("denies the shipped default-deny sites, including variants", () => {
    for (const host of ["linkedin.com", "www.linkedin.com", "linkedin.com:443", "LINKEDIN.com."]) {
      expect(engine.check({ capability: "browser", action: "navigate", host }), host).toMatchObject(
        { decision: "deny", rule: "site-default-deny" },
      );
    }
  });

  it("denies every prohibited action class", () => {
    for (const action of [
      "fingerprint-spoofing",
      "headless-evasion",
      "webdriver-masking",
      "proxy-rotation-for-evasion",
    ]) {
      expect(engine.check({ capability: "browser", action }), action).toMatchObject({
        decision: "deny",
        rule: "prohibited-action",
      });
    }
    for (const action of ["captcha-solving", "captcha-bypass", "captcha-service"]) {
      expect(engine.check({ capability: "browser", action }), action).toMatchObject({
        decision: "deny",
        rule: "prohibited-action",
      });
    }
    expect(engine.check({ capability: "browser", action: "type-credential" })).toMatchObject({
      rule: "prohibited-action",
    });
  });

  it("denies actions outside the declared allowlists", () => {
    expect(engine.check({ capability: "browser", action: "extract" })).toMatchObject({
      decision: "deny",
      rule: "action-not-permitted",
    });
    expect(
      engine.check({ capability: "computer", action: "serialize", consent: true }),
    ).toMatchObject({ decision: "deny", rule: "action-not-permitted" });
  });

  it("requires a target host for site-scoped browser actions", () => {
    expect(engine.check({ capability: "browser", action: "navigate" })).toMatchObject({
      decision: "deny",
      rule: "site-access-required",
    });
  });

  it("fails closed on unnamed or undeclared capabilities", () => {
    expect(engine.check()).toMatchObject({ decision: "deny", rule: "unknown-capability" });
    expect(engine.check({ action: "navigate", host: "example.com" })).toMatchObject({
      decision: "deny",
      rule: "unknown-capability",
    });
  });

  it("requires the recorded grant (INV-003) and interactive consent (ADR 0005)", () => {
    const ungranted = createGuardrailEngine(SHIPPED_GUARDRAILS, { granted: false });
    expect(
      ungranted.check({ capability: "browser", action: "navigate", host: "example.com" }),
    ).toMatchObject({ decision: "deny", rule: "grant-required" });
    expect(engine.check({ capability: "computer", action: "click" })).toMatchObject({
      decision: "deny",
      rule: "consent-required",
    });
  });

  it("throws a GuardrailError from assertAllowed", () => {
    expect(() =>
      engine.assertAllowed({ capability: "browser", action: "navigate", host: "linkedin.com" }),
    ).toThrow(GuardrailError);
  });
});

describe("guardrails policy floor", () => {
  const mutate = (patch: Record<string, unknown>): unknown => ({
    ...SHIPPED_GUARDRAILS,
    ...patch,
  });

  it("rejects a policy that drops the LinkedIn default-deny (INV-007)", () => {
    expect(() =>
      assertGuardrailsIntegrity(mutate({ siteAccess: { defaultDenySites: ["example.com"] } })),
    ).toThrow(/weakened.*INV-007/u);
  });

  it("rejects a policy that relaxes grants, consent, or site access", () => {
    const capabilities = SHIPPED_GUARDRAILS.capabilities;
    expect(() =>
      assertGuardrailsIntegrity(
        mutate({
          capabilities: {
            ...capabilities,
            browser: { ...capabilities.browser, grantRequired: false },
          },
        }),
      ),
    ).toThrow(/INV-003/u);
    expect(() =>
      assertGuardrailsIntegrity(
        mutate({
          capabilities: {
            ...capabilities,
            computer: { ...capabilities.computer, consentRequired: false },
          },
        }),
      ),
    ).toThrow(/ADR 0005/u);
    expect(() =>
      assertGuardrailsIntegrity(
        mutate({
          capabilities: {
            ...capabilities,
            browser: { ...capabilities.browser, siteAccessRequired: false },
          },
        }),
      ),
    ).toThrow(/INV-007/u);
  });

  it("rejects a policy that empties a prohibited class (INV-004)", () => {
    // an emptied list is malformed and rejected by the schema
    expect(() =>
      assertGuardrailsIntegrity(
        mutate({ prohibited: { ...SHIPPED_GUARDRAILS.prohibited, stealth: [] } }),
      ),
    ).toThrow();
    // dropping the class entirely is rejected by the integrity floor
    const without = (category: string): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(SHIPPED_GUARDRAILS.prohibited).filter(([key]) => key !== category),
      );
    expect(() => assertGuardrailsIntegrity(mutate({ prohibited: without("stealth") }))).toThrow(
      /INV-004/u,
    );
    expect(() => assertGuardrailsIntegrity(mutate({ prohibited: without("captcha") }))).toThrow(
      /INV-004/u,
    );
  });

  it("rejects unknown or malformed policy documents (typos fail closed)", () => {
    expect(() =>
      assertGuardrailsIntegrity({ ...SHIPPED_GUARDRAILS, defaultDecision: "allow" }),
    ).toThrow();
    expect(() => assertGuardrailsIntegrity({ ...SHIPPED_GUARDRAILS, extraRule: true })).toThrow();
  });
});

describe("kernel consults the policy engine (issue #124)", () => {
  function fixture(name: string, capabilities: string[]) {
    const seen: { ctx?: PluginContext } = {};
    return {
      seen,
      manifest: {
        name,
        version: "0.1.0",
        apiVersion: "1",
        kind: "harness",
        capabilities,
        permissions: { networkHosts: [], secrets: [] },
        config: {},
        entry: "createFixture",
        description: "guardrails kernel fixture",
      },
      factory: (ctx: PluginContext) => {
        seen.ctx = ctx;
        return { activate() {}, deactivate() {} };
      },
    };
  }

  it("refuses to construct with a weakened policy", () => {
    expect(
      () =>
        new Kernel("local", {
          guardrails: { ...SHIPPED_GUARDRAILS, siteAccess: { defaultDenySites: ["example.com"] } },
        }),
    ).toThrow(/weakened/u);
  });

  it("injects a policy-bound engine and denies LinkedIn / prohibited actions", async () => {
    const browser = fixture("guardrails-browser-fixture", ["browser"]);
    const kernel = new Kernel("local");
    kernel.register(browser.manifest, browser.factory);
    await kernel.activate("guardrails-browser-fixture", { grants: ["browser"] });

    const injected = browser.seen.ctx?.guardrails;
    expect(injected).toBeDefined();
    expect(
      injected?.check({ capability: "browser", action: "navigate", host: "example.com" }),
    ).toMatchObject({ decision: "allow" });
    expect(
      injected?.check({ capability: "browser", action: "navigate", host: "www.linkedin.com" }),
    ).toMatchObject({ decision: "deny", rule: "site-default-deny" });
    expect(() =>
      injected?.assertAllowed({ capability: "browser", action: "captcha-bypass" }),
    ).toThrow(GuardrailError);
  });

  it("denies capabilities the plugin does not declare", async () => {
    const browser = fixture("guardrails-scope-fixture", ["browser"]);
    const kernel = new Kernel("local");
    kernel.register(browser.manifest, browser.factory);
    await kernel.activate("guardrails-scope-fixture", { grants: ["browser"] });

    expect(
      browser.seen.ctx?.guardrails.check({ capability: "computer", action: "open" }),
    ).toMatchObject({ decision: "deny", rule: "unknown-capability" });
  });
});

describe("harnesses consult the engine for every action", () => {
  const browserDriver: BrowserDriver = {
    navigate: async () => {},
    scrollBy: async () => {},
    type: async () => {},
    click: async () => {},
    close: async () => {},
  };
  const desktopDriver: DesktopDriver = {
    open: async () => {},
    type: async () => {},
    click: async () => {},
    scroll: async () => {},
    key: async () => {},
    close: async () => {},
  };

  const narrowPolicy = assertGuardrailsIntegrity({
    ...SHIPPED_GUARDRAILS,
    capabilities: {
      browser: { ...SHIPPED_GUARDRAILS.capabilities.browser, allowedActions: ["navigate"] },
      computer: { ...SHIPPED_GUARDRAILS.capabilities.computer, allowedActions: ["open"] },
    },
  });

  it("browser harness denies an action the policy does not allow", async () => {
    const harness = createBrowserHarness({
      driver: browserDriver,
      sitePolicy: { assertAllowed: () => {} },
      sleep: async () => {},
    });
    await harness.activate({
      pluginName: "harness-browser",
      config: {},
      events: { emit: () => {} },
      guardrails: createGuardrailEngine(narrowPolicy, { granted: true }),
    } as unknown as PluginContext);

    const runLog = await harness.run(
      {
        kind: "browser",
        ownerId: "owner-a",
        instruction: "guardrails fixture",
        limits: { deadlineMs: 60_000, maxActions: 3 },
      },
      { actions: [{ kind: "scroll" }] },
    );
    expect(runLog.outcome).toBe("denied");
    expect(runLog.actions[0]).toMatchObject({
      allowed: false,
      deniedBy: expect.stringContaining("not an allowed browser action"),
    });
  });

  it("computer harness denies an action the policy does not allow", async () => {
    const harness = createComputerHarness({
      driver: desktopDriver,
      consent: { ask: async () => ({ allowed: true, rememberClass: true }) },
      sleep: async () => {},
    });
    await harness.activate({
      pluginName: "harness-computer",
      config: { enabled: true },
      events: { emit: () => {} },
      guardrails: createGuardrailEngine(narrowPolicy, { granted: true }),
    } as unknown as PluginContext);

    const runLog = await harness.run(
      {
        kind: "computer",
        ownerId: "owner-a",
        instruction: "guardrails fixture",
        limits: { deadlineMs: 60_000, maxActions: 3 },
      },
      { actions: [{ kind: "click", target: "Save" }] },
    );
    expect(runLog.outcome).toBe("denied");
    expect(runLog.actions[0]).toMatchObject({
      allowed: false,
      deniedBy: expect.stringContaining("not an allowed computer action"),
    });
  });
});
