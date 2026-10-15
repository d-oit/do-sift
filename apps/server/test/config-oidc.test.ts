import { describe, expect, it } from "vitest";
import { parseEnvConfig } from "../src/config.js";

const BASE = { DO_SIFT_OWNERS: "owner-alice", DO_SIFT_SEARCH_PROVIDER: "fixture" };
const OIDC = {
  DO_SIFT_OIDC_ISSUER: "https://idp.test",
  DO_SIFT_OIDC_AUDIENCE: "do-sift",
  DO_SIFT_OIDC_JWKS_URL: "https://idp.test/.well-known/jwks.json",
};

describe("DO_SIFT_OIDC_* configuration (R-17)", () => {
  it("leaves oidc unset when no variable is provided", () => {
    expect(parseEnvConfig({ ...BASE }).oidc).toBeUndefined();
  });

  it("parses all three variables into the oidc config", () => {
    expect(parseEnvConfig({ ...BASE, ...OIDC }).oidc).toEqual({
      issuer: "https://idp.test",
      audience: "do-sift",
      jwksUrl: "https://idp.test/.well-known/jwks.json",
    });
  });

  it("refuses a partial set", () => {
    const partial = { ...BASE, DO_SIFT_OIDC_ISSUER: "https://idp.test" };
    expect(() => parseEnvConfig(partial)).toThrow(/must be set together/);
  });

  it("refuses a non-https JWKS URL", () => {
    const insecure = { ...BASE, ...OIDC, DO_SIFT_OIDC_JWKS_URL: "http://idp.test/jwks" };
    expect(() => parseEnvConfig(insecure)).toThrow(/must be an https URL/);
  });
});
