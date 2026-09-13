/**
 * Auth skeleton (CORE-04). Two doors, both fail closed:
 *
 * 1. OIDC: a bearer id-token is verified by an OidcVerifier; the verified
 *    subject must be on the owner allowlist (timing-safe compare). This is
 *    the production door; a real verifier lands when credentials exist
 *    (sources.md gate). Until then the stub interface + StaticOidcVerifier
 *    serve tests and local flows.
 *
 * 2. Dev bypass: when explicitly enabled, a request with NO token from a
 *    loopback address acts as the configured dev owner — who must also be
 *    allowlisted. Disabled by default; any non-loopback address, missing
 *    address, or unallowlisted dev owner refuses.
 *
 * The service returns an ownerId for the caller to scope every repository
 * call (closes R-09 at the trust boundary; repositories stay owner-scoped
 * by construction).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isLoopbackAddress } from "./loopback.js";

export interface VerifiedIdentity {
  subject: string;
  issuer: string;
  claims: Readonly<Record<string, unknown>>;
}

/** Verifier interface for the real OIDC provider (stub until sources.md gate). */
export interface OidcVerifier {
  readonly issuer: string;
  /** Resolves the verified identity or throws; never returns unverified data. */
  verifyIdToken(token: string): Promise<VerifiedIdentity>;
}

/** Deterministic offline verifier for tests and local development only. */
export class StaticOidcVerifier implements OidcVerifier {
  readonly issuer: string;
  private readonly tokens: ReadonlyMap<string, VerifiedIdentity>;

  constructor(entries: Record<string, VerifiedIdentity>, issuer = "https://stub-issuer.test") {
    this.issuer = issuer;
    this.tokens = new Map(Object.entries(entries));
  }

  async verifyIdToken(token: string): Promise<VerifiedIdentity> {
    const identity = this.tokens.get(token);
    if (!identity) throw new Error("unknown or malformed id token");
    return identity;
  }
}

export type AuthFailureKind =
  "invalid-token" | "not-allowlisted" | "authentication-required" | "dev-bypass-refused";

export class AuthError extends Error {
  constructor(
    public readonly kind: AuthFailureKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "AuthError";
  }
}

export interface AuthConfig {
  /** Owner ids that may authenticate. Empty allowlist authenticates nobody. */
  allowlist: readonly string[];
  /** Master switch for the loopback dev bypass; default false. */
  devBypass: boolean;
  /** Owner the dev bypass acts as; must be allowlisted. */
  devOwner?: string | undefined;
}

export interface AuthRequest {
  /** Bearer token (raw; caller strips the scheme). Absent = try dev bypass. */
  token?: string | undefined;
  /** Client address as reported by the server (e.g. socket.remoteAddress). */
  clientAddress?: string | undefined;
}

export interface AuthenticatedOwner {
  ownerId: string;
  via: "oidc" | "dev-bypass";
}

/** Timing-safe allowlist membership: compare sha-256 digests, never raw. */
function isAllowlisted(candidate: string, allowlist: readonly string[]): boolean {
  const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
  return allowlist.some((allowed) =>
    timingSafeEqual(candidateHash, createHash("sha256").update(allowed, "utf8").digest()),
  );
}

export { isLoopbackAddress } from "./loopback.js";
export { parseClientHost } from "./loopback.js";

export class AuthService {
  constructor(
    private readonly verifier: OidcVerifier,
    private readonly config: AuthConfig,
    private readonly isLoopback: (address: string) => boolean = isLoopbackAddress,
  ) {}

  async authenticateOwner(request: AuthRequest): Promise<AuthenticatedOwner> {
    if (request.token !== undefined && request.token !== "") {
      let identity: VerifiedIdentity;
      try {
        identity = await this.verifier.verifyIdToken(request.token);
      } catch (e) {
        throw new AuthError(
          "invalid-token",
          `id token rejected: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!isAllowlisted(identity.subject, this.config.allowlist)) {
        throw new AuthError("not-allowlisted", "verified subject is not an allowlisted owner");
      }
      return { ownerId: identity.subject, via: "oidc" };
    }

    if (!this.config.devBypass) {
      throw new AuthError("authentication-required", "no token and dev bypass is disabled");
    }
    if (this.config.devOwner === undefined || this.config.devOwner === "") {
      throw new AuthError(
        "dev-bypass-refused",
        "dev bypass enabled but no dev owner is configured",
      );
    }
    if (request.clientAddress === undefined || !this.isLoopback(request.clientAddress)) {
      throw new AuthError("dev-bypass-refused", "dev bypass is loopback-only");
    }
    if (!isAllowlisted(this.config.devOwner, this.config.allowlist)) {
      throw new AuthError("not-allowlisted", "dev owner is not allowlisted");
    }
    return { ownerId: this.config.devOwner, via: "dev-bypass" };
  }
}
