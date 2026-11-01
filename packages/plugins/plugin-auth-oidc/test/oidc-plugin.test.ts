/**
 * Reference OIDC auth plugin tests (#120). Every case runs offline: the
 * verifier is the deterministic `StaticOidcVerifier`, so these cover the
 * plugin's config validation, manifest posture, and claim → Principal
 * mapping — not JWKS transport (that lives in `@do-sift/auth` tests).
 */
import { describe, expect, it } from "vitest";
import { StaticOidcVerifier, type VerifiedIdentity } from "@do-sift/auth";
import { AuthProviderError } from "@do-sift/contracts";
import { CapabilityError, Kernel, parseManifest, type PluginContext } from "@do-sift/kernel";
import manifestJson from "../plugin.json" with { type: "json" };
import { createOidcAuthPlugin, readOidcPluginConfig } from "../src/index.js";

const ALICE: VerifiedIdentity = {
  subject: "owner-alice",
  issuer: "https://idp.example.com",
  claims: { tenant_id: "tenant-acme", roles: ["member", "admin"] },
};

function verifier(): StaticOidcVerifier {
  return new StaticOidcVerifier({ "token-alice": ALICE }, "https://idp.example.com");
}

function ctx(
  config: Readonly<Record<string, unknown>> = manifestJson.config,
  allowedHosts: readonly string[] = ["idp.example.com"],
): PluginContext {
  const hosts = new Set(allowedHosts);
  return {
    pluginName: "auth-oidc",
    kind: "auth",
    config,
    logger: { info: () => {}, warn: () => {} },
    events: { emit: () => {} },
    network: {
      assertHostAllowed: (host: string) => {
        if (!hosts.has(host)) throw new CapabilityError(`host ${host} is not allowed`);
      },
    },
    secrets: {
      assertNameAllowed: () => {},
      resolve: async () => {
        throw new CapabilityError("no secret resolver");
      },
    },
  };
}

async function activeProvider(config?: Readonly<Record<string, unknown>>) {
  const plugin = createOidcAuthPlugin({ verifier: verifier() })(ctx(config));
  await plugin.activate(ctx(config));
  return plugin;
}

describe("auth-oidc manifest", () => {
  it("is a valid auth-kind plugin with network-only capabilities", () => {
    const manifest = parseManifest(manifestJson);
    expect(manifest.kind).toBe("auth");
    expect(manifest.capabilities).toEqual(["network"]);
    expect(manifest.permissions.networkHosts).toContain("idp.example.com");
  });

  it("registers and activates through the kernel without a grant", async () => {
    const kernel = new Kernel("ci");
    kernel.register(manifestJson, createOidcAuthPlugin({ verifier: verifier() }));
    await expect(kernel.activate("auth-oidc")).resolves.toBeUndefined();
    expect(kernel.isActivated("auth-oidc")).toBe(true);
  });
});

describe("auth-oidc provider", () => {
  it("maps verified claims to a tenant-scoped principal", async () => {
    const plugin = await activeProvider();
    const principal = await plugin.provider.authenticate({ token: "token-alice" });
    expect(principal).toEqual({
      tenantId: "tenant-acme",
      ownerId: "owner-alice",
      roles: ["member", "admin"],
      via: "oidc",
    });
  });

  it("fails closed without a token or with an unverifiable one", async () => {
    const plugin = await activeProvider();
    await expect(plugin.provider.authenticate({})).rejects.toMatchObject({
      kind: "authentication-required",
    });
    await expect(plugin.provider.authenticate({ token: "forged" })).rejects.toMatchObject({
      kind: "invalid-token",
    });
  });

  it("requires the tenant claim when one is configured", async () => {
    const plugin = await activeProvider({ ...manifestJson.config, tenantClaim: "org" });
    await expect(plugin.provider.authenticate({ token: "token-alice" })).rejects.toMatchObject({
      kind: "tenant-unresolved",
    });
  });

  it("falls back to the configured default tenant in single-tenant mode", async () => {
    const config = {
      issuer: manifestJson.config.issuer,
      audience: manifestJson.config.audience,
      jwksUrl: manifestJson.config.jwksUrl,
      defaultTenant: "tenant-solo",
    };
    const plugin = await activeProvider(config);
    await expect(plugin.provider.authenticate({ token: "token-alice" })).resolves.toMatchObject({
      tenantId: "tenant-solo",
    });
  });

  it("refuses tenants outside the configured allowlist", async () => {
    const plugin = await activeProvider({
      ...manifestJson.config,
      tenantAllowlist: ["tenant-other"],
    });
    await expect(plugin.provider.authenticate({ token: "token-alice" })).rejects.toMatchObject({
      kind: "tenant-forbidden",
    });
  });

  it("refuses activation when the JWKS host is not allowlisted by the manifest", async () => {
    const plugin = createOidcAuthPlugin({ verifier: verifier() })(ctx(manifestJson.config, []));
    expect(() => plugin.activate(ctx(manifestJson.config, []))).toThrow(CapabilityError);
    expect(() => plugin.provider).toThrow(AuthProviderError);
  });

  it("refuses a non-https JWKS URL and malformed config", () => {
    expect(() =>
      readOidcPluginConfig({ ...manifestJson.config, jwksUrl: "http://idp.example.com/jwks" }),
    ).toThrow(AuthProviderError);
    expect(() => readOidcPluginConfig({ ...manifestJson.config, issuer: "" })).toThrow(
      AuthProviderError,
    );
    expect(() => readOidcPluginConfig({ ...manifestJson.config, tenantAllowlist: [1] })).toThrow(
      AuthProviderError,
    );
  });

  it("drops the provider on deactivation", async () => {
    const plugin = await activeProvider();
    await plugin.deactivate();
    expect(() => plugin.provider).toThrow(/not active/);
  });
});
