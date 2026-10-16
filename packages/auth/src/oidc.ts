/**
 * Production OIDC verifier (R-17). Verifies an RS256- or ES384-signed id
 * token against the provider's JWKS, then checks iss / aud / exp / nbf. Uses
 * only node:crypto and the global fetch: no third-party JWT library. The
 * algorithm is pinned to an explicit allowlist (RS256, ES384), and each alg
 * may only verify with a key of its own type and curve, so `none`, HS*, and
 * RSA/EC key-confusion attacks are refused.
 *
 * Fail closed: any malformed token, unknown key, bad signature, or failed
 * claim check throws; the AuthService maps that to `invalid-token`.
 */
import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import type { OidcVerifier, VerifiedIdentity } from "./auth.js";

export interface JwksOidcVerifierOptions {
  /** Exact `iss` the token must carry (also reported as the identity issuer). */
  issuer: string;
  /** Token `aud` must contain this value. */
  audience: string;
  /** HTTPS URL of the provider's JSON Web Key Set. */
  jwksUrl: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Allowed clock skew for exp / nbf, in seconds (default 60). */
  clockSkewSeconds?: number;
  /** How long a fetched JWKS is reused before refresh, in ms (default 5 min). */
  jwksTtlMs?: number;
  /** Clock source, injected for tests. */
  now?: () => number;
}

/** Tokens larger than this are refused before any parsing (abuse bound). */
const MAX_TOKEN_BYTES = 8192;
const JWKS_TIMEOUT_MS = 5000;
/** Minimum gap between JWKS refreshes triggered by an unknown `kid`. */
const KID_REFRESH_MIN_MS = 30_000;

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface AlgSpec {
  /** JWA name, as it appears in the token header and the JWK `alg`. */
  name: string;
  kty: "RSA" | "EC";
  /** Required JWK `crv` for EC keys. */
  crv?: string;
  digest: "SHA256" | "SHA384";
  /** ECDSA signatures in JWS are raw r||s, not DER. */
  dsaEncoding?: "ieee-p1363";
}

/** The explicit algorithm allowlist. Anything else is refused. */
const ALG_SPECS: Record<string, AlgSpec> = {
  RS256: { name: "RS256", kty: "RSA", digest: "SHA256" },
  ES384: {
    name: "ES384",
    kty: "EC",
    crv: "P-384",
    digest: "SHA384",
    dsaEncoding: "ieee-p1363",
  },
};

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new Error("malformed base64url segment");
  return Buffer.from(segment, "base64url");
}

function decodeJsonObject(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(decodeSegment(segment).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export class JwksOidcVerifier implements OidcVerifier {
  readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly skewMs: number;
  private readonly jwksTtlMs: number;
  private readonly now: () => number;
  private keys: Jwk[] = [];
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;

  constructor(options: JwksOidcVerifierOptions) {
    if (options.issuer === "" || options.audience === "") {
      throw new Error("OIDC verifier needs a non-empty issuer and audience");
    }
    const url = new URL(options.jwksUrl);
    if (url.protocol !== "https:") {
      throw new Error("OIDC JWKS URL must use https");
    }
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.jwksUrl = options.jwksUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.skewMs = (options.clockSkewSeconds ?? 60) * 1000;
    this.jwksTtlMs = options.jwksTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async verifyIdToken(token: string): Promise<VerifiedIdentity> {
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new Error("token too large");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("token must have three segments");
    const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

    const header = decodeJsonObject(headerSeg);
    const spec =
      typeof header.alg === "string" && Object.hasOwn(ALG_SPECS, header.alg)
        ? ALG_SPECS[header.alg]
        : undefined;
    if (spec === undefined) throw new Error("unsupported alg");
    const kid = typeof header.kid === "string" ? header.kid : undefined;

    const key = await this.findKey(kid, spec);
    const signature = decodeSegment(signatureSeg);
    const verifier = createVerify(spec.digest);
    verifier.update(`${headerSeg}.${payloadSeg}`);
    verifier.end();
    const publicKey = createPublicKey({ key, format: "jwk" });
    const ok = verifier.verify(
      spec.dsaEncoding === undefined
        ? publicKey
        : { key: publicKey, dsaEncoding: spec.dsaEncoding },
      signature,
    );
    if (!ok) throw new Error("bad signature");

    const claims = decodeJsonObject(payloadSeg);
    this.checkClaims(claims);
    return { subject: claims.sub as string, issuer: this.issuer, claims };
  }

  private checkClaims(claims: Record<string, unknown>): void {
    if (claims.iss !== this.issuer) throw new Error("issuer mismatch");
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.audience)) throw new Error("audience mismatch");
    if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("missing subject");
    const nowMs = this.now();
    if (typeof claims.exp !== "number" || nowMs >= claims.exp * 1000 + this.skewMs) {
      throw new Error("token expired or no exp");
    }
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== "number" || nowMs < claims.nbf * 1000 - this.skewMs) {
        throw new Error("token not yet valid");
      }
    }
  }

  private async findKey(kid: string | undefined, spec: AlgSpec): Promise<Jwk> {
    const stale = this.now() - this.fetchedAt >= this.jwksTtlMs;
    if (stale) await this.refresh();
    let key = this.pickKey(kid, spec);
    // An unknown kid may mean the provider rotated keys: refresh once, rate-limited.
    if (key === undefined && !stale && this.now() - this.fetchedAt >= KID_REFRESH_MIN_MS) {
      await this.refresh();
      key = this.pickKey(kid, spec);
    }
    if (key === undefined) throw new Error("no matching signing key");
    return key;
  }

  private pickKey(kid: string | undefined, spec: AlgSpec): Jwk | undefined {
    const candidates = this.keys.filter(
      (k) =>
        k.kty === spec.kty &&
        (k.use === undefined || k.use === "sig") &&
        (k.alg === undefined || k.alg === spec.name) &&
        (spec.crv === undefined || k.crv === spec.crv),
    );
    if (kid !== undefined) return candidates.find((k) => k.kid === kid);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.fetchKeys().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchKeys(): Promise<void> {
    const res = await this.fetchImpl(this.jwksUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error("JWKS has no keys array");
    this.keys = body.keys.filter(
      (k): k is Jwk =>
        typeof k === "object" &&
        k !== null &&
        ((k as Jwk).kty === "RSA" || (k as Jwk).kty === "EC"),
    );
    this.fetchedAt = this.now();
  }
}
