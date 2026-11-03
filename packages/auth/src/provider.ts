/**
 * Owner-allowlist auth provider (issue #120, plan 024).
 *
 * The pre-multi-tenant behaviour, preserved as the fallback posture: a
 * verified OIDC subject must be on the owner allowlist, and the loopback dev
 * bypass stays structurally off unless explicitly enabled. The only addition
 * is that the resolved owner is also reported as a principal inside one
 * configured tenant — by default `DEFAULT_TENANT_ID`, the tenant migration
 * 0011 backfills every existing row into.
 *
 * Multi-tenant deployments use `@do-sift/plugin-auth-oidc` instead; this
 * provider exists so the single-owner shape never needs a tenant claim.
 */
import { DEFAULT_TENANT_ID, parseAuthPrincipal } from "@do-sift/contracts";
import type { AuthPrincipal, AuthProvider, AuthProviderRequest } from "@do-sift/contracts";
import type { AuthService } from "./auth.js";

export interface OwnerAllowlistProviderOptions {
  /**
   * Tenant the allowlisted owners belong to. Must be a single, explicit
   * tenant: this provider never derives tenancy from a token.
   */
  tenantId?: string | undefined;
}

export class OwnerAllowlistAuthProvider implements AuthProvider {
  readonly id = "owner-allowlist";
  readonly mode = "owner-allowlist" as const;
  private readonly tenantId: string;

  constructor(
    private readonly service: AuthService,
    options: OwnerAllowlistProviderOptions = {},
  ) {
    this.tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
    if (this.tenantId.trim() === "") {
      throw new Error("owner-allowlist provider needs a non-empty tenant id");
    }
  }

  async authenticate(request: AuthProviderRequest): Promise<AuthPrincipal> {
    const owner = await this.service.authenticateOwner(request);
    return parseAuthPrincipal({
      tenantId: this.tenantId,
      userId: owner.ownerId,
      // The allowlist door is the deployment owner; the label is advisory.
      roles: [owner.via === "dev-bypass" ? "dev" : "owner"],
    });
  }
}
