import { describe, expect, it } from "vitest";
import {
  buildCacheKey,
  normalizeQuestion,
  planReservation,
  reconcile,
  validateCitations,
  CitationError,
  type Answer,
} from "@do-sift/contracts";
import { Kernel, CapabilityError, type PluginContext, type PluginFactory } from "@do-sift/kernel";
import greeterJson from "../../plugins/sample-greeter/plugin.json" with { type: "json" };
import { createGreeter } from "../../plugins/sample-greeter/src/index.js";

describe("cache keys", () => {
  const base = {
    ownerId: "owner-1",
    mode: "answer" as const,
    language: "en",
    sourceVersions: ["abc12345"],
    policyRevision: "p1",
    promptRevision: "pr1",
    modelRevision: "m1",
  };

  it("normalizes whitespace and case but preserves negation", () => {
    expect(normalizeQuestion("Does   X support Windows?")).toBe("does x support windows?");
    expect(normalizeQuestion("does X NOT support windows")).not.toBe(
      normalizeQuestion("does x support windows"),
    );
  });

  it("never shares a key across owners or modes", () => {
    const k1 = buildCacheKey({ ...base, question: "Does X support Windows?" });
    const k2 = buildCacheKey({ ...base, ownerId: "owner-2", question: "does X support windows" });
    const k3 = buildCacheKey({
      ...base,
      question: "does x support windows",
      mode: "search" as const,
    });
    expect(k1).not.toEqual(k2);
    expect(k1).not.toEqual(k3);
    expect(k1).toBe(buildCacheKey({ ...base, question: "does   X support Windows? " }));
  });
});

describe("budgets", () => {
  it("rejects estimates above the input ceiling", () => {
    expect(() =>
      planReservation(
        {
          maxInputTokens: 100,
          maxOutputTokens: 50,
          maxSearchCalls: 1,
          maxFetches: 3,
          deadlineMs: 30_000,
        },
        101,
        0,
      ),
    ).toThrow(/exceeds budget/);
  });

  it("rounds reservations to the ceilings and flags overruns", () => {
    const r = planReservation(
      {
        maxInputTokens: 4000,
        maxOutputTokens: 700,
        maxSearchCalls: 1,
        maxFetches: 3,
        deadlineMs: 30_000,
      },
      3900,
      1000,
    );
    expect(r.expiresAtMs).toBe(31_000);
    expect(reconcile(r, { inputTokens: 3800, outputTokens: 600 })).toMatchObject({
      overrun: false,
    });
    expect(reconcile(r, { inputTokens: 4200, outputTokens: 100 })).toMatchObject({ overrun: true });
  });
});

describe("citations", () => {
  const answer: Answer = {
    ownerId: "owner-1",
    question: "q",
    evidenceOnly: false,
    blocks: [{ kind: "paragraph", text: "claim", citations: ["ev-1", "ev-2"] }],
  };

  it("passes when all citations resolve to stored evidence", () => {
    expect(() => validateCitations(answer, new Set(["ev-1", "ev-2", "ev-3"]))).not.toThrow();
  });

  it("fails closed on unknown evidence ids", () => {
    try {
      validateCitations(answer, new Set(["ev-1"]));
      expect.unreachable("expected CitationError");
    } catch (e) {
      expect(e).toBeInstanceOf(CitationError);
      expect((e as CitationError).unknownIds).toEqual(["ev-2"]);
    }
  });
});

describe("kernel secrets service (CORE-02)", () => {
  const seedy = {
    ...greeterJson,
    name: "seedy-plugin",
    kind: "storage" as const,
    permissions: { networkHosts: [], secrets: ["TURSO_TOKEN", "UNSET_SECRET"] },
  };
  const capture: PluginFactory = (ctx) => {
    capturedCtx = ctx;
    return { activate() {}, deactivate() {} };
  };
  let capturedCtx: PluginContext | undefined;

  it("resolves an allowlisted secret via the host resolver", async () => {
    const kernel = new Kernel("local", {
      secretResolver: async (name) => (name === "TURSO_TOKEN" ? "tok-123" : undefined),
    });
    kernel.register(seedy, capture);
    await kernel.activate("seedy-plugin");
    await expect(capturedCtx?.secrets.resolve("TURSO_TOKEN")).resolves.toBe("tok-123");
  });

  it("refuses names outside the manifest allowlist", async () => {
    const kernel = new Kernel("local", { secretResolver: async () => "tok" });
    kernel.register(seedy, capture);
    await kernel.activate("seedy-plugin");
    await expect(capturedCtx?.secrets.resolve("EVIL_SECRET")).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });

  it("refuses resolution without a resolver or with an unavailable secret", async () => {
    const kernel = new Kernel("local");
    kernel.register(seedy, capture);
    await kernel.activate("seedy-plugin");
    await expect(capturedCtx?.secrets.resolve("TURSO_TOKEN")).rejects.toThrow(/no secret resolver/);

    const kernel2 = new Kernel("local", { secretResolver: async () => undefined });
    kernel2.register(seedy, capture);
    await kernel2.activate("seedy-plugin");
    await expect(capturedCtx?.secrets.resolve("UNSET_SECRET")).rejects.toThrow(/not available/);
  });
});

describe("kernel round-trip (FND-07)", () => {
  const paidBase = () => ({
    ...greeterJson,
    kind: "model",
    capabilities: ["paid"],
    permissions: { networkHosts: [], secrets: [] },
  });
  const factory: PluginFactory = (ctx) => createGreeter(ctx);

  it("activates a granted-free plugin and deactivates it", async () => {
    const kernel = new Kernel("local");
    kernel.register(greeterJson, factory);
    expect(kernel.isActivated("sample-greeter")).toBe(false);
    await kernel.activate("sample-greeter");
    expect(kernel.isActivated("sample-greeter")).toBe(true);
    await kernel.deactivate("sample-greeter");
    expect(kernel.isActivated("sample-greeter")).toBe(false);
  });

  it("refuses activation of a paid plugin without a grant (INV-003)", async () => {
    const paid = {
      ...greeterJson,
      name: "paid-plugin",
      kind: "model",
      capabilities: ["paid", "network"],
      permissions: { networkHosts: ["api.example.com"], secrets: ["PAID_KEY"] },
    };
    const kernel = new Kernel("local");
    kernel.register(paid, factory);
    await expect(kernel.activate("paid-plugin")).rejects.toBeInstanceOf(CapabilityError);

    kernel.grant("paid-plugin", "paid");
    await expect(kernel.activate("paid-plugin")).resolves.toBeUndefined();
  });

  it("refuses grant-requiring plugins outright in ci (INV-003)", async () => {
    const paid = {
      ...greeterJson,
      name: "paid-plugin-ci",
      kind: "model",
      capabilities: ["paid"],
    };
    const kernel = new Kernel("ci");
    kernel.register(paid, factory);
    kernel.grant("paid-plugin-ci", "paid");
    await expect(kernel.activate("paid-plugin-ci")).rejects.toThrow(/cannot activate in ci/);
  });

  it("a grant for one plugin does not authorize another plugin (#60)", async () => {
    const kernel = new Kernel("local");
    const a = { ...paidBase(), name: "paid-a" };
    const b = { ...paidBase(), name: "paid-b" };
    kernel.register(a, () => ({ activate() {}, deactivate() {} }));
    kernel.register(b, () => ({ activate() {}, deactivate() {} }));
    kernel.grant("paid-a", "paid");
    await expect(kernel.activate("paid-a")).resolves.toBeUndefined();
    await expect(kernel.activate("paid-b")).rejects.toBeInstanceOf(CapabilityError);
  });

  it("activation-scoped grants do not persist after the activation (#60)", async () => {
    const kernel = new Kernel("local");
    kernel.register({ ...paidBase(), name: "paid-plugin" }, () => ({
      activate() {},
      deactivate() {},
    }));
    await kernel.activate("paid-plugin", { grants: ["paid"] });
    await kernel.deactivate("paid-plugin");
    await expect(kernel.activate("paid-plugin")).rejects.toBeInstanceOf(CapabilityError);
  });

  it("browser capability requires an explicit grant (#60)", async () => {
    const kernel = new Kernel("local");
    kernel.register({ ...paidBase(), name: "browser-x", capabilities: ["browser"] }, () => ({
      activate() {},
      deactivate() {},
    }));
    await expect(kernel.activate("browser-x")).rejects.toBeInstanceOf(CapabilityError);
  });

  it("blocks network hosts outside the manifest allowlist", async () => {
    const netted = {
      ...greeterJson,
      name: "netted-plugin",
      kind: "search",
      capabilities: ["network"],
      permissions: { networkHosts: ["api.allowed.test"], secrets: [] },
    };
    const kernel = new Kernel("local");
    let capturedHost: ((host: string) => void) | undefined;
    const probe: PluginFactory = (ctx) => {
      capturedHost = (host: string) => ctx.network.assertHostAllowed(host);
      return { activate() {}, deactivate() {} };
    };
    kernel.register(netted, probe);
    await kernel.activate("netted-plugin");
    expect(() => capturedHost?.("api.allowed.test")).not.toThrow();
    expect(() => capturedHost?.("evil.test")).toThrow(CapabilityError);
  });

  describe("per-user / per-tenant capability grants (#120)", () => {
    const paid = (name: string) => ({
      ...greeterJson,
      name,
      kind: "model",
      capabilities: ["paid"],
      permissions: { networkHosts: [], secrets: [] },
    });
    const factory: PluginFactory = () => ({ activate() {}, deactivate() {} });
    const acmeMember = { tenantId: "tenant-acme", ownerId: "owner-alice" };
    const acmeOther = { tenantId: "tenant-acme", ownerId: "owner-bob" };
    const globexMember = { tenantId: "tenant-globex", ownerId: "owner-carol" };

    it("a tenant-wide grant authorizes that tenant only", async () => {
      const kernel = new Kernel("local");
      kernel.register(paid("tenant-tool"), factory);
      kernel.grantScoped({ tenantId: "tenant-acme" }, "tenant-tool", "paid");

      await expect(kernel.activate("tenant-tool", { principal: globexMember })).rejects.toThrow(
        /explicit grants for \[paid\]/,
      );
      await expect(
        kernel.activate("tenant-tool", { principal: acmeMember }),
      ).resolves.toBeUndefined();
      expect(kernel.effectiveGrants("tenant-tool", acmeMember).has("paid")).toBe(true);
      expect(kernel.effectiveGrants("tenant-tool", globexMember).has("paid")).toBe(false);
    });

    it("a per-user grant does not authorize another user in the same tenant", async () => {
      const kernel = new Kernel("local");
      kernel.register(paid("user-tool"), factory);
      kernel.grantScoped({ tenantId: "tenant-acme", ownerId: "owner-alice" }, "user-tool", "paid");

      expect(kernel.effectiveGrants("user-tool", acmeOther).has("paid")).toBe(false);
      await expect(kernel.activate("user-tool", { principal: acmeOther })).rejects.toBeInstanceOf(
        CapabilityError,
      );
      expect(kernel.effectiveGrants("user-tool", acmeMember).has("paid")).toBe(true);
      await expect(
        kernel.activate("user-tool", { principal: acmeMember }),
      ).resolves.toBeUndefined();
    });

    it("legacy instance-wide grants still apply to every caller", async () => {
      const kernel = new Kernel("local");
      kernel.register(paid("legacy-tool"), factory);
      kernel.grant("legacy-tool", "paid");
      expect(kernel.effectiveGrants("legacy-tool", globexMember).has("paid")).toBe(true);
      await expect(
        kernel.activate("legacy-tool", { principal: globexMember }),
      ).resolves.toBeUndefined();
    });

    it("scoped grants are refused in ci and validation fails closed", async () => {
      const kernel = new Kernel("ci");
      kernel.register(paid("ci-tenant-tool"), factory);
      kernel.grantScoped({ tenantId: "tenant-acme" }, "ci-tenant-tool", "paid");
      await expect(kernel.activate("ci-tenant-tool", { principal: acmeMember })).rejects.toThrow(
        /cannot activate in ci/,
      );

      const local = new Kernel("local");
      expect(() => local.grantScoped({ tenantId: " " }, "x", "paid")).toThrow(CapabilityError);
      expect(() =>
        local.grantScoped({ tenantId: "tenant-acme", ownerId: "" }, "x", "paid"),
      ).toThrow(CapabilityError);
    });

    it("activation-scoped grants stay scoped to that activation", async () => {
      const kernel = new Kernel("local");
      kernel.register(paid("ephemeral-tool"), factory);
      await kernel.activate("ephemeral-tool", { grants: ["paid"], principal: acmeMember });
      await kernel.deactivate("ephemeral-tool");
      expect(kernel.effectiveGrants("ephemeral-tool", acmeMember).has("paid")).toBe(false);
      await expect(
        kernel.activate("ephemeral-tool", { principal: acmeMember }),
      ).rejects.toBeInstanceOf(CapabilityError);
    });
  });
});
