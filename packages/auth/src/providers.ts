/**
 * Auth providers (#120). Two implementations of the contracts `AuthProvider`
 * interface live here:
 *
 * - `AllowlistAuthProvider` — the legacy owner-allowlist door, wrapped as a
 *   provider. This is the fallback that keeps single-owner deployments
 *   working unchanged.
 * - `OidcPrincipalProvider` — OIDC id-token → `Principal` mapping. The
 *   reference plugin (`@do-sift/plugin-auth-oidc`) wraps exactly this class,
 *   so the plugin layer adds capability/kernel wiring, not auth logic.
 *
 * Both fail closed and translate internal errors into
 * `AuthProviderError` kinds from the contracts, so callers never depend on a
 * specific implementation's error shape.
 */
import {
  AuthProviderError,
  Principal,
  TenantId,
  type AuthProvider,
  type AuthProviderRequest,
} from "@do-sift/contracts";
import {
  AuthError,
  DEFAULT_TENANT_ID,
  type AuthService,
  type OidcVerifier,
  type VerifiedIdentity,
} from "./auth.js";

function failureKind(kind: string): AuthProviderError["kind"] {
  switch (kind) {
    case "invalid-token":
    case "not-allowlisted":
    case "authentication-required":
    case "dev-bypass-refused":
    case "tenant-unresolved":
      return kind;
    default:
      return "provider-unavailable";
  }
}

function toProviderError(error: unknown): AuthProviderError {
  if (error instanceof AuthProviderError) return error;
  if (error instanceof AuthError) {
    return new AuthProviderError(failureKind(error.kind), error.message);
  }
  return new AuthProviderError(
    "provider-unavailable",
    error instanceof Error ? error.message : "authentication failed",
  );
}

function requestOf(request: AuthProviderRequest): {
  token?: string | undefined;
  clientAddress?: string | undefined;
} {
  const built: { token?: string | undefined; clientAddress?: string | undefined } = {};
  if (request.token !== undefined) built.token = request.token;
  if (request.clientAddress !== undefined) built.clientAddress = request.clientAddress;
  return built;
}

/**
 * Owner-allowlist door as an `AuthProvider` (#120 acceptance: "the
 * owner-allowlist mode remains available as a fallback"). Every resolved
 * owner is granted the `owner` role and the tenant the underlying
 * `AuthService` resolved.
 */
export class AllowlistAuthProvider implements AuthProvider {
  readonly id = "owner-allowlist";

  constructor(private readonly service: AuthService) {}

  async authenticate(request: AuthProviderRequest): Promise<Principal> {
    try {
      const owner = await this.service.authenticateOwner(requestOf(request));
      return Principal.parse({
        tenantId: owner.tenantId,
        ownerId: owner.ownerId,
        roles: ["owner"],
        via: owner.via,
      });
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

export interface OidcPrincipalOptions {
  /** Signature/claim verifier (JWKS in production, static in tests). */
  verifier: OidcVerifier;
  /**
   * Verified claim naming the caller's tenant. When set, a missing or
   * malformed claim fails closed (`tenant-unresolved`) — it never silently
   * lands in the default tenant.
   */
  tenantClaim?: string | undefined;
  /** Tenant used when `tenantClaim` is not configured. Default `default`. */
  defaultTenant?: string | undefined;
  /** Claim carrying role strings. Unset → no roles are asserted. */
  rolesClaim?: string | undefined;
  /** Optional accepted-tenant allowlist; any other tenant is refused. */
  tenantAllowlist?: readonly string[] | undefined;
}

/**
 * OIDC id-token → `Principal` provider. Tenant and roles come from verified
 * claims only; anything unverifiable fails closed.
 */
export class OidcPrincipalProvider implements AuthProvider {
  readonly id = "oidc";

  constructor(private readonly options: OidcPrincipalOptions) {}

  async authenticate(request: AuthProviderRequest): Promise<Principal> {
    if (request.token === undefined || request.token === "") {
      throw new AuthProviderError(
        "authentication-required",
        "OIDC authentication requires a bearer id token",
      );
    }
    let identity: VerifiedIdentity;
    try {
      identity = await this.options.verifier.verifyIdToken(request.token);
    } catch {
      throw new AuthProviderError("invalid-token", "id token rejected");
    }
    const tenantId = this.resolveTenant(identity);
    return this.principalFor(identity, tenantId);
  }

  private resolveTenant(identity: VerifiedIdentity): string {
    const claim = this.options.tenantClaim;
    if (claim === undefined || claim === "") {
      const fallback = this.options.defaultTenant ?? DEFAULT_TENANT_ID;
      const parsed = TenantId.safeParse(fallback);
      if (!parsed.success) {
        throw new AuthProviderError("tenant-unresolved", "configured default tenant is invalid");
      }
      this.assertTenantAllowed(parsed.data);
      return parsed.data;
    }
    const raw = identity.claims[claim];
    if (typeof raw !== "string" || raw === "") {
      throw new AuthProviderError("tenant-unresolved", `id token has no "${claim}" claim`);
    }
    const parsed = TenantId.safeParse(raw);
    if (!parsed.success) {
      throw new AuthProviderError(
        "tenant-unresolved",
        `id token "${claim}" claim is not a valid tenant id`,
      );
    }
    this.assertTenantAllowed(parsed.data);
    return parsed.data;
  }

  private assertTenantAllowed(tenantId: string): void {
    const allowlist = this.options.tenantAllowlist;
    if (allowlist === undefined) return;
    if (!allowlist.includes(tenantId)) {
      throw new AuthProviderError("tenant-forbidden", `tenant ${tenantId} is not accepted here`);
    }
  }

  private principalFor(identity: VerifiedIdentity, tenantId: string): Principal {
    const parsed = Principal.safeParse({
      tenantId,
      ownerId: identity.subject,
      roles: this.rolesFor(identity),
      via: "oidc",
    });
    if (!parsed.success) {
      throw new AuthProviderError(
        "invalid-token",
        `verified identity is not a valid principal: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
    }
    return parsed.data;
  }

  private rolesFor(identity: VerifiedIdentity): string[] {
    const claim = this.options.rolesClaim;
    if (claim === undefined || claim === "") return [];
    const raw = identity.claims[claim];
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === "string");
  }
}
