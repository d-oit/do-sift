import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import { PrincipalGrants } from "@do-sift/kernel";
import { AuthService, OwnerAllowlistAuthProvider, StaticOidcVerifier } from "@do-sift/auth";

describe("PrincipalGrants (issue #120)", () => {
  it("denies by default", () => {
    const grants = new PrincipalGrants();
    expect(grants.check({ tenantId: "acme", userId: "u1" }, "paid")).toEqual({
      allowed: false,
      reason: "not-granted",
    });
  });

  it("grants are per tenant: the same user id in another tenant gets nothing", () => {
    const grants = new PrincipalGrants();
    grants.grantTenant("acme", "paid");
    grants.grantUser("acme", "u1", "computer");
    expect(grants.check({ tenantId: "acme", userId: "u1" }, "paid")).toEqual({
      allowed: true,
      reason: "tenant-grant",
    });
    expect(grants.check({ tenantId: "globex", userId: "u1" }, "paid")).toEqual({
      allowed: false,
      reason: "not-granted",
    });
    expect(grants.check({ tenantId: "globex", userId: "u1" }, "computer")).toEqual({
      allowed: false,
      reason: "not-granted",
    });
  });

  it("a user grant does not spill to the rest of the tenant", () => {
    const grants = new PrincipalGrants();
    grants.grantUser("acme", "u1", "browser");
    expect(grants.check({ tenantId: "acme", userId: "u1" }, "browser").allowed).toBe(true);
    expect(grants.check({ tenantId: "acme", userId: "u2" }, "browser").allowed).toBe(false);
  });

  it("reports the effective union and honours revocations", () => {
    const grants = new PrincipalGrants();
    grants.grantTenant("acme", "paid", "network");
    grants.grantUser("acme", "u1", "browser");
    expect(grants.effective({ tenantId: "acme", userId: "u1" })).toEqual([
      "browser",
      "network",
      "paid",
    ]);
    grants.revokeUser("acme", "u1", "browser");
    expect(grants.effective({ tenantId: "acme", userId: "u1" })).toEqual(["network", "paid"]);
    grants.revokeTenant("acme", "paid");
    expect(grants.check({ tenantId: "acme", userId: "u1" }, "paid").allowed).toBe(false);
  });

  it("refuses empty identities rather than granting broadly", () => {
    const grants = new PrincipalGrants();
    expect(() => grants.grantTenant("", "paid")).toThrow(/tenant id/);
    expect(grants.check({ tenantId: "" }, "paid").allowed).toBe(false);
    expect(() => grants.grantUser("acme", "", "paid")).toThrow(/user id/);
  });
});

describe("Kernel.authorizeForPrincipal (issue #120)", () => {
  const manifest = {
    name: "spendy-plugin",
    version: "0.1.0",
    apiVersion: "1" as const,
    kind: "model" as const,
    capabilities: ["paid" as const],
    permissions: { networkHosts: [], secrets: [] },
    config: {},
    entry: "create",
    description: "test plugin with a billable capability",
  };

  it("requires BOTH the plugin grant and a principal grant", async () => {
    const kernel = new Kernel("local");
    kernel.register(manifest, () => ({ activate: () => {}, deactivate: () => {} }));
    const acmeUser = { tenantId: "acme", userId: "u1" };

    // principal grant alone: the plugin itself was never granted
    kernel.grantTenant("acme", "paid");
    expect((await kernel.authorizeForPrincipal("spendy-plugin", acmeUser, "paid")).allowed).toBe(
      false,
    );

    // plugin grant alone: this principal still holds nothing
    kernel.grant("spendy-plugin", "paid");
    expect(
      (
        await kernel.authorizeForPrincipal(
          "spendy-plugin",
          { tenantId: "globex", userId: "u1" },
          "paid",
        )
      ).allowed,
    ).toBe(false);

    // both gates pass for the granted tenant
    await expect(kernel.authorizeForPrincipal("spendy-plugin", acmeUser, "paid")).resolves.toEqual({
      allowed: true,
      reason: "tenant-grant",
    });
  });

  it("never authorizes a capability the plugin does not declare", async () => {
    const kernel = new Kernel("local");
    kernel.register(manifest, () => ({ activate: () => {}, deactivate: () => {} }));
    kernel.grant("spendy-plugin", "computer");
    kernel.grantTenant("acme", "computer");
    expect(
      (await kernel.authorizeForPrincipal("spendy-plugin", { tenantId: "acme" }, "computer"))
        .allowed,
    ).toBe(false);
  });

  it("requires tenant membership on top of both grants", async () => {
    const kernel = new Kernel("local", {
      membership: {
        roleOf: async (tenantId, userId) =>
          tenantId === "acme" && userId === "u1" ? "member" : undefined,
      },
    });
    kernel.register(manifest, () => ({ activate: () => {}, deactivate: () => {} }));
    kernel.grant("spendy-plugin", "paid");
    kernel.grantTenant("acme", "paid");

    await expect(
      kernel.authorizeForPrincipal("spendy-plugin", { tenantId: "acme", userId: "u1" }, "paid"),
    ).resolves.toEqual({ allowed: true, reason: "tenant-grant" });

    // The tenant grant exists, but this user holds no membership in it.
    await expect(
      kernel.authorizeForPrincipal(
        "spendy-plugin",
        { tenantId: "acme", userId: "intruder" },
        "paid",
      ),
    ).resolves.toEqual({ allowed: false, reason: "not-a-member" });

    // Membership in another tenant does not authorize this one.
    await expect(
      kernel.authorizeForPrincipal("spendy-plugin", { tenantId: "globex", userId: "u1" }, "paid"),
    ).resolves.toEqual({ allowed: false, reason: "not-a-member" });

    // A principal without a user id cannot be a member of anything.
    await expect(
      kernel.authorizeForPrincipal("spendy-plugin", { tenantId: "acme" }, "paid"),
    ).resolves.toEqual({ allowed: false, reason: "not-a-member" });
  });

  it("useMembership() starts enforcing a directory configured after construction", async () => {
    const kernel = new Kernel("local");
    kernel.register(manifest, () => ({ activate: () => {}, deactivate: () => {} }));
    kernel.grant("spendy-plugin", "paid");
    kernel.grantTenant("acme", "paid");
    const principal = { tenantId: "acme", userId: "u1" };

    // No directory yet: the recorded grant decides (pre-#120 behaviour).
    await expect(kernel.authorizeForPrincipal("spendy-plugin", principal, "paid")).resolves.toEqual(
      { allowed: true, reason: "tenant-grant" },
    );

    kernel.useMembership({ roleOf: async () => undefined });
    await expect(kernel.authorizeForPrincipal("spendy-plugin", principal, "paid")).resolves.toEqual(
      { allowed: false, reason: "not-a-member" },
    );
  });
});

describe("owner-allowlist fallback provider (issue #120)", () => {
  const TOKENS = {
    "token-me": { subject: "owner-me", issuer: "https://stub-issuer.test", claims: {} },
  } as const;

  function provider(tenantId?: string): OwnerAllowlistAuthProvider {
    const service = new AuthService(new StaticOidcVerifier({ ...TOKENS }), {
      allowlist: ["owner-me"],
      devBypass: false,
    });
    return new OwnerAllowlistAuthProvider(service, tenantId === undefined ? {} : { tenantId });
  }

  it("preserves the single-owner behaviour inside a tenant", async () => {
    await expect(provider().authenticate({ token: "token-me" })).resolves.toEqual({
      tenantId: "default",
      userId: "owner-me",
      roles: ["owner"],
    });
    await expect(provider("acme").authenticate({ token: "token-me" })).resolves.toMatchObject({
      tenantId: "acme",
    });
  });

  it("still refuses unauthenticated and unallowlisted callers", async () => {
    await expect(provider().authenticate({})).rejects.toMatchObject({
      kind: "authentication-required",
    });
    await expect(provider().authenticate({ token: "other" })).rejects.toMatchObject({
      kind: "invalid-token",
    });
  });
});
