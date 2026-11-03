/**
 * Per-principal capability grants (issue #120, plan 024).
 *
 * Before this module a capability grant was recorded per plugin for the whole
 * deployment ("the owner allowed this plugin to spend"). That is too coarse
 * for a shared instance: one tenant's decision must never authorize another
 * tenant's user, and a tenant-wide grant must not silently become global.
 *
 * The model is intentionally small and deny-by-default:
 *
 *   - a **tenant** grant authorizes every user of that tenant;
 *   - a **user** grant authorizes exactly that (tenant, user) pair;
 *   - a grant for tenant A is invisible to tenant B, even for the same
 *     userId string — tenants are different security domains;
 *   - no grant, no authorization. Nothing is inferred from roles.
 *
 * This class is a pure, in-memory decision registry. Persistence and the UI
 * that records grants are host concerns; the kernel only judges.
 */
import type { Capability } from "./manifest.js";

/** The principal shape grants are evaluated against (subset of AuthPrincipal). */
export interface GrantPrincipal {
  readonly tenantId: string;
  readonly userId?: string | undefined;
}

export type PrincipalGrantReason =
  | "tenant-grant"
  | "user-grant"
  | "not-granted"
  /** The principal holds no membership in the tenant it claims (issue #120). */
  | "not-a-member";

export interface PrincipalGrantDecision {
  readonly allowed: boolean;
  readonly reason: PrincipalGrantReason;
}

/** Composite map key: tenant and user can never be confused by concatenation. */
function userKey(tenantId: string, userId: string): string {
  return `${tenantId}\u0000${userId}`;
}

export class PrincipalGrants {
  private readonly tenantGrants = new Map<string, Set<Capability>>();
  private readonly userGrants = new Map<string, Set<Capability>>();

  /** Authorize every user of a tenant for these capabilities. */
  grantTenant(tenantId: string, ...capabilities: readonly Capability[]): void {
    if (tenantId === "") throw new Error("grantTenant requires a non-empty tenant id");
    let set = this.tenantGrants.get(tenantId);
    if (set === undefined) {
      set = new Set<Capability>();
      this.tenantGrants.set(tenantId, set);
    }
    for (const capability of capabilities) set.add(capability);
  }

  /** Authorize exactly one user (inside one tenant) for these capabilities. */
  grantUser(tenantId: string, userId: string, ...capabilities: readonly Capability[]): void {
    if (tenantId === "") throw new Error("grantUser requires a non-empty tenant id");
    if (userId === "") throw new Error("grantUser requires a non-empty user id");
    const key = userKey(tenantId, userId);
    let set = this.userGrants.get(key);
    if (set === undefined) {
      set = new Set<Capability>();
      this.userGrants.set(key, set);
    }
    for (const capability of capabilities) set.add(capability);
  }

  /** Drop a tenant grant (all users) for these capabilities. */
  revokeTenant(tenantId: string, ...capabilities: readonly Capability[]): void {
    const set = this.tenantGrants.get(tenantId);
    if (set === undefined) return;
    for (const capability of capabilities) set.delete(capability);
    if (set.size === 0) this.tenantGrants.delete(tenantId);
  }

  /** Drop a single user's grant inside one tenant. */
  revokeUser(tenantId: string, userId: string, ...capabilities: readonly Capability[]): void {
    const key = userKey(tenantId, userId);
    const set = this.userGrants.get(key);
    if (set === undefined) return;
    for (const capability of capabilities) set.delete(capability);
    if (set.size === 0) this.userGrants.delete(key);
  }

  /** Judge one capability for one principal. */
  check(principal: GrantPrincipal, capability: Capability): PrincipalGrantDecision {
    if (principal.tenantId === "") {
      return { allowed: false, reason: "not-granted" };
    }
    if (principal.userId !== undefined && principal.userId !== "") {
      const userSet = this.userGrants.get(userKey(principal.tenantId, principal.userId));
      if (userSet?.has(capability) === true) return { allowed: true, reason: "user-grant" };
    }
    const tenantSet = this.tenantGrants.get(principal.tenantId);
    if (tenantSet?.has(capability) === true) return { allowed: true, reason: "tenant-grant" };
    return { allowed: false, reason: "not-granted" };
  }

  /** Effective capabilities for a principal (user grants ∪ tenant grants). */
  effective(principal: GrantPrincipal): Capability[] {
    const effective = new Set<Capability>();
    for (const capability of this.tenantGrants.get(principal.tenantId) ?? []) {
      effective.add(capability);
    }
    if (principal.userId !== undefined && principal.userId !== "") {
      for (const capability of this.userGrants.get(userKey(principal.tenantId, principal.userId)) ??
        []) {
        effective.add(capability);
      }
    }
    return [...effective].sort();
  }

  /** Test/teardown helper: forget every recorded grant. */
  clear(): void {
    this.tenantGrants.clear();
    this.userGrants.clear();
  }
}
