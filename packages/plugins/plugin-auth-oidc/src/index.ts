/**
 * Multi-tenant OIDC auth provider (issue #120, plan 024).
 *
 * The reference multi-tenant door: a bearer id-token is verified by an
 * injected `OidcVerifier` (JWKS transport stays host-owned — this plugin does
 * no I/O, so it declares zero capabilities), then the tenant claim and user
 * subject are mapped to an `AuthPrincipal`:
 *
 *   - `tenantClaim` (default `tenant`) must be a non-empty string, or the
 *     configured `defaultTenantId` applies (single-tenant OIDC deployments);
 *     neither present → `tenant-claim-missing`, never a guessed tenant.
 *   - `tenantAllowlist`, when non-empty, is exhaustive: an unlisted tenant is
 *     refused with `tenant-not-allowed`.
 *   - `rolesClaim` (default `roles`) maps string arrays (or a space-delimited
 *     string) to advisory role labels. Malformed roles degrade to
 *     `defaultRoles` — roles never grant anything, so this is not an auth
 *     decision.
 *
 * Claim lookup is by exact key, not dotted path: OIDC claim names are often
 * URLs (`https://example.com/tenant`), so splitting on dots would break them.
 */
import { AuthError, type OidcVerifier, type VerifiedIdentity } from "@do-sift/auth";
import {
  parseAuthPrincipal,
  type AuthPrincipal,
  type AuthProvider,
  type AuthProviderRequest,
} from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface OidcAuthConfig {
  /** OIDC verifier (typically `JwksOidcVerifier`). Required to activate. */
  verifier?: unknown;
  /** Claim carrying the tenant id; default `tenant`. */
  tenantClaim?: unknown;
  /** Claim carrying role labels; default `roles`. */
  rolesClaim?: unknown;
  /** Roles used when the roles claim is absent or malformed; default none. */
  defaultRoles?: unknown;
  /** Exhaustive when non-empty: only these tenants may authenticate. */
  tenantAllowlist?: unknown;
  /** Tenant used when the claim is absent; unset = claim required. */
  defaultTenantId?: unknown;
}

const DEFAULTS = { tenantClaim: "tenant", rolesClaim: "roles" } as const;

export interface OidcAuthPlugin extends PluginInstance, AuthProvider {
  readonly id: "auth-oidc";
  readonly mode: "multi-tenant";
  authenticate(request: AuthProviderRequest): Promise<AuthPrincipal>;
}

function isVerifier(value: unknown): value is OidcVerifier {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OidcVerifier).verifyIdToken === "function"
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("expected an array of strings");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("expected non-empty string entries");
    }
    return entry.trim();
  });
}

/** Roles are informational: malformed input degrades, it never denies. */
function readRoles(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const roles = value.filter((entry): entry is string => typeof entry === "string");
    if (roles.length !== value.length) return undefined;
    return roles.map((role) => role.trim()).filter((role) => role !== "");
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim().split(/\s+/u);
  }
  return undefined;
}

interface ResolvedConfig {
  verifier: OidcVerifier;
  tenantClaim: string;
  rolesClaim: string;
  defaultRoles: string[];
  tenantAllowlist: string[];
  defaultTenantId?: string | undefined;
}

function resolveConfig(raw: unknown): ResolvedConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("auth-oidc needs a config object");
  }
  const config = raw as OidcAuthConfig;
  if (!isVerifier(config.verifier)) {
    throw new Error("auth-oidc needs an OidcVerifier (config.verifier.verifyIdToken)");
  }
  const resolved: ResolvedConfig = {
    verifier: config.verifier,
    tenantClaim: optionalString(config.tenantClaim) ?? DEFAULTS.tenantClaim,
    rolesClaim: optionalString(config.rolesClaim) ?? DEFAULTS.rolesClaim,
    defaultRoles: stringList(config.defaultRoles) ?? [],
    tenantAllowlist: stringList(config.tenantAllowlist) ?? [],
  };
  const defaultTenantId = optionalString(config.defaultTenantId);
  if (defaultTenantId !== undefined) resolved.defaultTenantId = defaultTenantId;
  return resolved;
}

function principalFor(identity: VerifiedIdentity, config: ResolvedConfig): AuthPrincipal {
  if (identity.subject === "" || identity.subject.trim() === "") {
    throw new AuthError("invalid-token", "verified identity has no subject");
  }
  const claimed = identity.claims[config.tenantClaim];
  const tenantId = optionalString(claimed) ?? config.defaultTenantId;
  if (tenantId === undefined) {
    throw new AuthError(
      "tenant-claim-missing",
      `token has no usable "${config.tenantClaim}" claim and no default tenant is configured`,
    );
  }
  if (config.tenantAllowlist.length > 0 && !config.tenantAllowlist.includes(tenantId)) {
    throw new AuthError("tenant-not-allowed", "token tenant is not permitted on this deployment");
  }
  const roles = readRoles(identity.claims[config.rolesClaim]) ?? config.defaultRoles;
  return parseAuthPrincipal({ tenantId, userId: identity.subject, roles });
}

/** Create the OIDC auth plugin (inactive until `activate`). */
export function createOidcAuthPlugin(): OidcAuthPlugin {
  let config: ResolvedConfig | undefined;

  return {
    id: "auth-oidc",
    mode: "multi-tenant",

    activate(context): void {
      config = resolveConfig(context.config);
      context.events.emit("auth-oidc.activated", {
        tenantClaim: config.tenantClaim,
        tenantAllowlist: config.tenantAllowlist.length,
        defaultTenant: config.defaultTenantId !== undefined,
      });
    },

    deactivate(): void {
      config = undefined;
    },

    async authenticate(request: AuthProviderRequest): Promise<AuthPrincipal> {
      if (config === undefined) throw new Error("auth-oidc is not activated");
      const token = request.token;
      if (token === undefined || token === "") {
        throw new AuthError("authentication-required", "no bearer token");
      }
      let identity: VerifiedIdentity;
      try {
        identity = await config.verifier.verifyIdToken(token);
      } catch {
        throw new AuthError("invalid-token", "id token rejected");
      }
      return principalFor(identity, config);
    },
  };
}
