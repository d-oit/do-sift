import { describe, expect, it } from "vitest";
import {
  AuthProviderError,
  assertSameTenant,
  TenantIsolationError,
  type Principal,
} from "@do-sift/contracts";
import {
  AllowlistAuthProvider,
  AuthService,
  OidcPrincipalProvider,
  StaticOidcVerifier,
  type VerifiedIdentity,
} from "../src/index.js";

const ALICE: VerifiedIdentity = {
  subject: "owner-alice",
  issuer: "https://stub-issuer.test",
  claims: { tenant_id: "tenant-acme", roles: ["member"] },
};

const verifier = (): StaticOidcVerifier =>
  new StaticOidcVerifier({ "token-alice": ALICE }, "https://stub-issuer.test");

describe("AllowlistAuthProvider (owner-allowlist fallback)", () => {
  const service = (devBypass = false): AuthService =>
    new AuthService(verifier(), {
      allowlist: ["owner-alice"],
      devBypass,
      ...(devBypass ? { devOwner: "owner-alice" } : {}),
    });

  it("maps an allowlisted owner to an owner-role principal", async () => {
    const provider = new AllowlistAuthProvider(service());
    await expect(provider.authenticate({ token: "token-alice" })).resolves.toEqual({
      tenantId: "default",
      ownerId: "owner-alice",
      roles: ["owner"],
      via: "oidc",
    });
  });

  it("keeps the loopback dev bypass working through the provider", async () => {
    const provider = new AllowlistAuthProvider(service(true));
    await expect(provider.authenticate({ clientAddress: "127.0.0.1" })).resolves.toMatchObject({
      ownerId: "owner-alice",
      tenantId: "default",
      via: "dev-bypass",
    });
  });

  it("translates auth failures into AuthProviderError kinds", async () => {
    const provider = new AllowlistAuthProvider(service());
    await expect(provider.authenticate({})).rejects.toMatchObject({
      kind: "authentication-required",
      name: "AuthProviderError",
    });
    await expect(provider.authenticate({ token: "forged" })).rejects.toMatchObject({
      kind: "invalid-token",
    });
    await expect(provider.authenticate({ token: "forged" })).rejects.toBeInstanceOf(
      AuthProviderError,
    );
  });
});

describe("OidcPrincipalProvider", () => {
  it("maps verified tenant and role claims", async () => {
    const provider = new OidcPrincipalProvider({
      verifier: verifier(),
      tenantClaim: "tenant_id",
      rolesClaim: "roles",
    });
    await expect(provider.authenticate({ token: "token-alice" })).resolves.toEqual({
      tenantId: "tenant-acme",
      ownerId: "owner-alice",
      roles: ["member"],
      via: "oidc",
    });
  });

  it("fails closed when the tenant claim is missing or malformed", async () => {
    const provider = new OidcPrincipalProvider({
      verifier: verifier(),
      tenantClaim: "org_id",
    });
    await expect(provider.authenticate({ token: "token-alice" })).rejects.toMatchObject({
      kind: "tenant-unresolved",
    });

    const hostile = new OidcPrincipalProvider({
      verifier: new StaticOidcVerifier({
        "token-alice": { ...ALICE, claims: { tenant_id: "tenant id with spaces" } },
      }),
      tenantClaim: "tenant_id",
    });
    await expect(hostile.authenticate({ token: "token-alice" })).rejects.toMatchObject({
      kind: "tenant-unresolved",
    });
  });

  it("enforces the tenant allowlist", async () => {
    const provider = new OidcPrincipalProvider({
      verifier: verifier(),
      tenantClaim: "tenant_id",
      tenantAllowlist: ["tenant-globex"],
    });
    await expect(provider.authenticate({ token: "token-alice" })).rejects.toMatchObject({
      kind: "tenant-forbidden",
    });
  });

  it("refuses an oversized subject as a principal", async () => {
    const provider = new OidcPrincipalProvider({
      verifier: new StaticOidcVerifier({
        "token-long": { ...ALICE, subject: "o".repeat(129) },
      }),
      tenantClaim: "tenant_id",
    });
    await expect(provider.authenticate({ token: "token-long" })).rejects.toMatchObject({
      kind: "invalid-token",
    });
  });
});

describe("assertSameTenant", () => {
  const principal: Principal = {
    tenantId: "tenant-acme",
    ownerId: "owner-alice",
    roles: [],
    via: "oidc",
  };

  it("passes inside the tenant and throws across it", () => {
    expect(() => assertSameTenant({ ...principal }, "tenant-acme")).not.toThrow();
    expect(() => assertSameTenant({ ...principal }, "tenant-globex")).toThrow(TenantIsolationError);
  });
});
