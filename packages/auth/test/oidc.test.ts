import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthService, JwksOidcVerifier } from "../src/index.js";

const ISSUER = "https://idp.test";
const AUDIENCE = "do-sift";
const JWKS_URL = "https://idp.test/.well-known/jwks.json";
const NOW_S = 1_800_000_000;

const primary = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkOf(publicKey: KeyObject, kid: string): Record<string, unknown> {
  return { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function b64url(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString(
    "base64url",
  );
}

function sign(
  payload: Record<string, unknown>,
  opts: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "k1" };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  if ((opts.alg ?? "RS256") === "none") return `${signingInput}.`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const key = opts.key ?? primary.privateKey;
  return `${signingInput}.${signer.sign(key).toString("base64url")}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "owner-alice",
    iat: NOW_S,
    exp: NOW_S + 600,
    ...overrides,
  };
}

/** Fake provider: serves `keys` at JWKS_URL and counts fetches. */
function makeJwksFetch(keys: () => Record<string, unknown>[]) {
  const state = { fetches: 0, status: 200 };
  const fetchImpl = (async (input: string | URL | Request) => {
    expect(String(input)).toBe(JWKS_URL);
    state.fetches += 1;
    if (state.status !== 200) return new Response("nope", { status: state.status });
    return new Response(JSON.stringify({ keys: keys() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, state };
}

function makeVerifier(opts: { now?: () => number; keys?: () => Record<string, unknown>[] } = {}) {
  const jwks = makeJwksFetch(opts.keys ?? (() => [jwkOf(primary.publicKey, "k1")]));
  const verifier = new JwksOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
    fetchImpl: jwks.fetchImpl,
    now: opts.now ?? (() => NOW_S * 1000),
  });
  return { verifier, jwks: jwks.state };
}

describe("JwksOidcVerifier: accepted tokens", () => {
  it("verifies a valid RS256 token and returns the subject as identity", async () => {
    const { verifier } = makeVerifier();
    const identity = await verifier.verifyIdToken(sign(validPayload()));
    expect(identity).toMatchObject({ subject: "owner-alice", issuer: ISSUER });
    expect(identity.claims).toMatchObject({ aud: AUDIENCE });
  });

  it("accepts an audience array that contains the configured audience", async () => {
    const { verifier } = makeVerifier();
    const token = sign(validPayload({ aud: ["other", AUDIENCE] }));
    await expect(verifier.verifyIdToken(token)).resolves.toMatchObject({ subject: "owner-alice" });
  });

  it("tolerates small clock skew on exp and nbf", async () => {
    const { verifier } = makeVerifier();
    const expired = sign(validPayload({ exp: NOW_S - 30 })); // within 60s skew
    await expect(verifier.verifyIdToken(expired)).resolves.toBeDefined();
    const early = sign(validPayload({ nbf: NOW_S + 30 }));
    await expect(verifier.verifyIdToken(early)).resolves.toBeDefined();
  });
});

describe("JwksOidcVerifier: rejected tokens (fail closed)", () => {
  it.each([
    ["alg none", () => sign(validPayload(), { alg: "none" })],
    ["alg HS256 (key-confusion)", () => sign(validPayload(), { alg: "HS256" })],
    ["wrong issuer", () => sign(validPayload({ iss: "https://evil.test" }))],
    ["wrong audience", () => sign(validPayload({ aud: "someone-else" }))],
    ["expired", () => sign(validPayload({ exp: NOW_S - 120 }))],
    ["not yet valid", () => sign(validPayload({ nbf: NOW_S + 120 }))],
    ["missing exp", () => sign({ iss: ISSUER, aud: AUDIENCE, sub: "owner-alice" })],
    ["missing sub", () => sign(validPayload({ sub: "" }))],
    ["signed by another key", () => sign(validPayload(), { key: rotated.privateKey })],
    ["unknown kid", () => sign(validPayload(), { kid: "nope" })],
    ["two segments", () => "abc.def"],
    ["non-base64url segment", () => `${b64url({ alg: "RS256" })}.@@@.sig`],
  ])("rejects %s", async (_label, make) => {
    const { verifier } = makeVerifier();
    await expect(verifier.verifyIdToken(make())).rejects.toThrow();
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const { verifier } = makeVerifier();
    const [h, , s] = sign(validPayload()).split(".");
    const forged = b64url(validPayload({ sub: "owner-bob" }));
    await expect(verifier.verifyIdToken(`${h}.${forged}.${s}`)).rejects.toThrow(/bad signature/);
  });

  it("rejects oversized tokens before parsing", async () => {
    const { verifier, jwks } = makeVerifier();
    await expect(verifier.verifyIdToken("a".repeat(9000))).rejects.toThrow(/too large/);
    expect(jwks.fetches).toBe(0);
  });
});

describe("JwksOidcVerifier: keys and transport", () => {
  it("refuses a non-https JWKS URL at construction", () => {
    expect(
      () =>
        new JwksOidcVerifier({
          issuer: ISSUER,
          audience: AUDIENCE,
          jwksUrl: "http://idp.test/jwks",
        }),
    ).toThrow(/https/);
  });

  it("caches the JWKS between verifications", async () => {
    const { verifier, jwks } = makeVerifier();
    await verifier.verifyIdToken(sign(validPayload()));
    await verifier.verifyIdToken(sign(validPayload()));
    expect(jwks.fetches).toBe(1);
  });

  it("picks up a rotated key once an unknown kid appears", async () => {
    let clockMs = NOW_S * 1000;
    let keys = [jwkOf(primary.publicKey, "k1")];
    const { verifier, jwks } = makeVerifier({ now: () => clockMs, keys: () => keys });
    await verifier.verifyIdToken(sign(validPayload()));

    keys = [jwkOf(rotated.publicKey, "k2")];
    const rotatedToken = sign(validPayload(), { key: rotated.privateKey, kid: "k2" });
    // Within the rate-limit window the unknown kid is not refetched.
    await expect(verifier.verifyIdToken(rotatedToken)).rejects.toThrow(/no matching/);
    clockMs += 31_000;
    await expect(verifier.verifyIdToken(rotatedToken)).resolves.toMatchObject({
      subject: "owner-alice",
    });
    expect(jwks.fetches).toBe(2);
  });

  it("fails closed when the JWKS endpoint errors", async () => {
    const { verifier, jwks } = makeVerifier();
    jwks.status = 503;
    await expect(verifier.verifyIdToken(sign(validPayload()))).rejects.toThrow(/503/);
  });
});

describe("JwksOidcVerifier through AuthService", () => {
  it("maps a bad token to invalid-token and an unallowlisted subject to not-allowlisted", async () => {
    const { verifier } = makeVerifier();
    const auth = new AuthService(verifier, { allowlist: ["owner-alice"], devBypass: false });
    await expect(
      auth.authenticateOwner({ token: sign(validPayload({ aud: "x" })) }),
    ).rejects.toMatchObject({ kind: "invalid-token" });
    await expect(
      auth.authenticateOwner({ token: sign(validPayload({ sub: "owner-bob" })) }),
    ).rejects.toMatchObject({ kind: "not-allowlisted" });
    const ok = await auth.authenticateOwner({ token: sign(validPayload()) });
    expect(ok).toEqual({ ownerId: "owner-alice", via: "oidc" });
  });
});
