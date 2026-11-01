import { z } from "zod";
import { OwnerId } from "./common.js";

/**
 * Multi-tenant auth contracts (#120, ADR 0010).
 *
 * The kernel and the storage layer must never depend on a specific identity
 * implementation, so everything they need is expressed here:
 *
 * - `TenantId` — the isolation boundary every stored row and every
 *   capability grant is scoped to.
 * - `Principal` — the authenticated caller: a tenant, an owner (user), and
 *   the roles the identity provider asserted.
 * - `AuthProvider` — the pluggable door. The owner-allowlist deployment
 *   (`@do-sift/auth` `AllowlistAuthProvider`) and the OIDC reference plugin
 *   (`@do-sift/plugin-auth-oidc`) are two implementations of the same
 *   interface, which is what keeps single-owner mode available as a
 *   fallback.
 *
 * See `docs/auth.md` for the wiring rules and the fail-closed matrix.
 */

/**
 * Tenant identifiers are opaque to the engine; they are restricted to a
 * conservative URL/SQL-safe alphabet so a claim can never smuggle
 * separators or whitespace into a query or a grant key.
 */
export const TenantId = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    "tenant ids are 1-128 chars of [A-Za-z0-9._:-] starting alphanumeric",
  );
export type TenantId = z.infer<typeof TenantId>;

/** Channel a principal was authenticated through. */
export const AuthChannel = z.enum(["oidc", "allowlist", "dev-bypass"]);
export type AuthChannel = z.infer<typeof AuthChannel>;

export const PrincipalRole = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9._-]*$/u, "roles are lowercase kebab/snake identifiers");
export type PrincipalRole = z.infer<typeof PrincipalRole>;

/**
 * Authenticated caller. `tenantId` + `ownerId` together form the storage
 * scope; `roles` feed capability evaluation; `via` is the audit receipt of
 * which door authenticated the request.
 */
export const Principal = z
  .object({
    tenantId: TenantId,
    ownerId: OwnerId,
    roles: z.array(PrincipalRole).max(32).default([]),
    via: AuthChannel,
  })
  .strict();
export type Principal = z.infer<typeof Principal>;

/** Credentials handed to an auth provider. Both fields are optional: the
 * provider decides which door they open (and must fail closed otherwise). */
export interface AuthProviderRequest {
  /** Bearer token with the scheme stripped. */
  token?: string | undefined;
  /** Client address as reported by the server (socket.remoteAddress). */
  clientAddress?: string | undefined;
}

export type AuthProviderFailureKind =
  | "invalid-token"
  | "not-allowlisted"
  | "authentication-required"
  | "dev-bypass-refused"
  | "tenant-unresolved"
  | "tenant-forbidden"
  | "provider-unavailable";

/**
 * Pluggable authentication interface (#120). A provider resolves the
 * verified caller or throws; it must never return unverified data. The
 * kernel depends on this interface only.
 */
export interface AuthProvider {
  /** Stable provider id, e.g. `oidc` or `owner-allowlist`. */
  readonly id: string;
  authenticate(request: AuthProviderRequest): Promise<Principal>;
}

export class AuthProviderError extends Error {
  constructor(
    public readonly kind: AuthProviderFailureKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "AuthProviderError";
  }
}

/** Raised when a scoped read/write crosses a tenant boundary. */
export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Fail closed on any cross-tenant access. Storage repositories call this
 * before returning a row; kernel grants call it before handing out a
 * capability.
 */
export function assertSameTenant(principal: Principal, tenantId: TenantId): void {
  if (principal.tenantId !== tenantId) {
    throw new TenantIsolationError(
      `principal tenant ${principal.tenantId} cannot access tenant ${tenantId}`,
    );
  }
}

/** Parse + validate an identity string as a tenant id (fail closed). */
export function parseTenantId(value: string): TenantId {
  return TenantId.parse(value);
}
