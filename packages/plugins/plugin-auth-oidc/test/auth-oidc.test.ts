import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import { AuthError, StaticOidcVerifier, type VerifiedIdentity } from "@do-sift/auth";
import pluginJson from "../plugin.json" with { type: "json" };
import { createOidcAuthPlugin, type OidcAuthPlugin } from "../src/index.js";

const ISSUER = "https://idp.test";

const TOKENS: Record<string, VerifiedIdentity> = {
  "token-alice": {
    subject: "user-alice",
    issuer: ISSUER,
    claims: { tenant: "acme", roles: ["owner", "member"] },
  },
  "token-bob": {
    subject: "user-bob",
    issuer: ISSUER,
    claims: { tenant: "globex", roles: "member" },
  },
  "token-no-tenant": {
    subject: "user-carol",
    issuer: ISSUER,
    claims: { roles: ["member"] },
  },
  "token-bad-roles": {
    subject: "user-dave",
    issuer: ISSUER,
    claims: { tenant: "acme", roles: [1, 2] },
  },
};

async function activated(config: Record<string, unknown> = {}): Promise<OidcAuthPlugin> {
  const plugin = createOidcAuthPlugin();
  await plugin.activate({
    pluginName: "auth-oidc",
    config: { verifier: new StaticOidcVerifier(TOKENS, ISSUER), ...config },
    events: { emit: () => {} },
  } as unknown as Parameters<OidcAuthPlugin["activate"]>[0]);
  return plugin;
}

describe("tenant mapping (fail closed)", () => {
  it("maps the tenant claim and subject to a principal", async () => {
    const plugin = await activated();
    await expect(plugin.authenticate({ token: "token-alice" })).resolves.toEqual({
      tenantId: "acme",
      userId: "user-alice",
      roles: ["owner", "member"],
    });
    // A space-delimited roles claim is accepted too.
    await expect(plugin.authenticate({ token: "token-bob" })).resolves.toMatchObject({
      tenantId: "globex",
      roles: ["member"],
    });
  });

  it("refuses a token with no tenant claim and no default tenant", async () => {
    const plugin = await activated();
    await expect(plugin.authenticate({ token: "token-no-tenant" })).rejects.toMatchObject({
      kind: "tenant-claim-missing",
    });
  });

  it("uses the configured default tenant only as an explicit fallback", async () => {
    const plugin = await activated({ defaultTenantId: "acme" });
    await expect(plugin.authenticate({ token: "token-no-tenant" })).resolves.toMatchObject({
      tenantId: "acme",
      userId: "user-carol",
    });
  });

  it("treats a non-empty tenant allowlist as exhaustive", async () => {
    const plugin = await activated({ tenantAllowlist: ["acme"] });
    await expect(plugin.authenticate({ token: "token-bob" })).rejects.toMatchObject({
      kind: "tenant-not-allowed",
    });
    await expect(plugin.authenticate({ token: "token-alice" })).resolves.toMatchObject({
      tenantId: "acme",
    });
  });

  it("refuses missing and unverifiable credentials", async () => {
    const plugin = await activated();
    await expect(plugin.authenticate({})).rejects.toBeInstanceOf(AuthError);
    await expect(plugin.authenticate({})).rejects.toMatchObject({
      kind: "authentication-required",
    });
    await expect(plugin.authenticate({ token: "forged" })).rejects.toMatchObject({
      kind: "invalid-token",
    });
  });

  it("degrades malformed roles to the configured defaults instead of denying", async () => {
    const plugin = await activated({ defaultRoles: ["member"] });
    await expect(plugin.authenticate({ token: "token-bad-roles" })).resolves.toMatchObject({
      roles: ["member"],
    });
  });

  it("supports a custom claim name and exact-key lookup", async () => {
    const plugin = createOidcAuthPlugin();
    await plugin.activate({
      pluginName: "auth-oidc",
      config: {
        verifier: new StaticOidcVerifier(
          {
            "token-url": {
              subject: "user-eve",
              issuer: ISSUER,
              claims: { "https://idp.test/tenant": "tenant-x" },
            },
          },
          ISSUER,
        ),
        tenantClaim: "https://idp.test/tenant",
      },
      events: { emit: () => {} },
    } as unknown as Parameters<OidcAuthPlugin["activate"]>[0]);
    await expect(plugin.authenticate({ token: "token-url" })).resolves.toMatchObject({
      tenantId: "tenant-x",
    });
  });

  it("refuses to authenticate before activation or without a verifier", async () => {
    const plugin = createOidcAuthPlugin();
    await expect(plugin.authenticate({ token: "token-alice" })).rejects.toThrow(/not activated/);
    expect(() =>
      plugin.activate({
        pluginName: "auth-oidc",
        config: {},
        events: { emit: () => {} },
      } as unknown as Parameters<OidcAuthPlugin["activate"]>[0]),
    ).toThrow(/OidcVerifier/);
  });
});

describe("kernel round-trip", () => {
  it("declares no capabilities and activates through the kernel", async () => {
    expect(pluginJson.kind).toBe("auth");
    expect(pluginJson.capabilities).toEqual([]);
    const kernel = new Kernel("local");
    let instance: OidcAuthPlugin | undefined;
    kernel.register(
      { ...pluginJson, config: { verifier: new StaticOidcVerifier(TOKENS, ISSUER) } },
      () => {
        instance = createOidcAuthPlugin();
        return instance;
      },
    );
    await kernel.activate("auth-oidc");
    await expect(instance?.authenticate({ token: "token-alice" })).resolves.toMatchObject({
      tenantId: "acme",
    });
    await kernel.deactivate("auth-oidc");
    await expect(instance?.authenticate({ token: "token-alice" })).rejects.toThrow(/not activated/);
  });
});
