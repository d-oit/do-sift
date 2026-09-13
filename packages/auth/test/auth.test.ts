import { describe, expect, it } from "vitest";
import {
  AuthError,
  AuthService,
  StaticOidcVerifier,
  isLoopbackAddress,
  parseClientHost,
  type VerifiedIdentity,
} from "../src/index.js";

const ALICE: VerifiedIdentity = {
  subject: "owner-alice",
  issuer: "https://stub-issuer.test",
  claims: {},
};

function makeVerifier(): StaticOidcVerifier {
  return new StaticOidcVerifier({ "token-alice": ALICE });
}

describe("loopback classification (fail closed)", () => {
  it("accepts literal loopback forms", () => {
    for (const addr of [
      "127.0.0.1",
      "127.1.2.3", // whole 127/8 is loopback
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "[::1]:8080",
      "127.0.0.1:54321",
    ]) {
      expect(isLoopbackAddress(addr), addr).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const addr of [
      "8.8.8.8",
      "10.0.0.1",
      "192.168.1.10",
      "::ffff:8.8.8.8",
      "2001:db8::1",
      "fe80::1",
      "localhost", // names never count — IP-strict by design
      "",
      "not an address",
      "[]",
    ]) {
      expect(isLoopbackAddress(addr), addr).toBe(false);
    }
  });

  it("reduces client-address forms to a bare host", () => {
    expect(parseClientHost("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(parseClientHost("[::1]:9999")).toBe("::1");
    expect(parseClientHost("::1")).toBe("::1");
    expect(parseClientHost(" 127.0.0.1 ")).toBe("127.0.0.1");
  });
});

describe("AuthService — OIDC door", () => {
  it("authenticates an allowlisted verified subject", async () => {
    const svc = new AuthService(makeVerifier(), { allowlist: ["owner-alice"], devBypass: false });
    await expect(svc.authenticateOwner({ token: "token-alice" })).resolves.toEqual({
      ownerId: "owner-alice",
      via: "oidc",
    });
  });

  it("refuses unknown/malformed tokens (invalid-token)", async () => {
    const svc = new AuthService(makeVerifier(), { allowlist: ["owner-alice"], devBypass: false });
    await expect(svc.authenticateOwner({ token: "forged" })).rejects.toMatchObject({
      kind: "invalid-token",
    });
  });

  it("refuses verified subjects outside the allowlist (not-allowlisted)", async () => {
    const mallory: VerifiedIdentity = {
      subject: "owner-mallory",
      issuer: "https://stub-issuer.test",
      claims: {},
    };
    const verifier = new StaticOidcVerifier({ "token-mallory": mallory });
    const svc = new AuthService(verifier, { allowlist: ["owner-alice"], devBypass: false });
    await expect(svc.authenticateOwner({ token: "token-mallory" })).rejects.toMatchObject({
      kind: "not-allowlisted",
    });
  });

  it("empty allowlist authenticates nobody", async () => {
    const svc = new AuthService(makeVerifier(), { allowlist: [], devBypass: false });
    await expect(svc.authenticateOwner({ token: "token-alice" })).rejects.toBeInstanceOf(AuthError);
  });
});

describe("AuthService — dev bypass door", () => {
  const bypassConfig = { allowlist: ["owner-alice"], devBypass: true, devOwner: "owner-alice" };

  it("authenticates a loopback request as the dev owner", async () => {
    const svc = new AuthService(makeVerifier(), bypassConfig);
    await expect(svc.authenticateOwner({ clientAddress: "127.0.0.1" })).resolves.toEqual({
      ownerId: "owner-alice",
      via: "dev-bypass",
    });
    await expect(svc.authenticateOwner({ clientAddress: "[::1]:4000" })).resolves.toMatchObject({
      via: "dev-bypass",
    });
  });

  it("refuses the bypass when disabled, even from loopback", async () => {
    const svc = new AuthService(makeVerifier(), {
      allowlist: ["owner-alice"],
      devBypass: false,
      devOwner: "owner-alice",
    });
    await expect(svc.authenticateOwner({ clientAddress: "127.0.0.1" })).rejects.toMatchObject({
      kind: "authentication-required",
    });
  });

  it("refuses the bypass from non-loopback addresses", async () => {
    const svc = new AuthService(makeVerifier(), bypassConfig);
    for (const addr of ["8.8.8.8", "10.0.0.1", "::ffff:8.8.8.8", "localhost", ""]) {
      await expect(svc.authenticateOwner({ clientAddress: addr }), addr).rejects.toMatchObject({
        kind: "dev-bypass-refused",
      });
    }
  });

  it("refuses the bypass without a client address or without a dev owner", async () => {
    const svc = new AuthService(makeVerifier(), bypassConfig);
    await expect(svc.authenticateOwner({})).rejects.toMatchObject({ kind: "dev-bypass-refused" });

    const noDev = new AuthService(makeVerifier(), {
      allowlist: ["owner-alice"],
      devBypass: true,
    });
    await expect(noDev.authenticateOwner({ clientAddress: "127.0.0.1" })).rejects.toMatchObject({
      kind: "dev-bypass-refused",
    });
  });

  it("refuses when the dev owner is not allowlisted", async () => {
    const svc = new AuthService(makeVerifier(), {
      allowlist: ["owner-alice"],
      devBypass: true,
      devOwner: "owner-evil",
    });
    await expect(svc.authenticateOwner({ clientAddress: "127.0.0.1" })).rejects.toMatchObject({
      kind: "not-allowlisted",
    });
  });
});
