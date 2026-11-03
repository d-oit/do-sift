/**
 * Authentication provider contract (issue #120, plan 024).
 *
 * Before this module the kernel only knew an owner allowlist: one deployment
 * served one owner, and every repository call was scoped by `ownerId`. That
 * is still supported (`mode: "owner-allowlist"`), but it is no longer the
 * only shape. A provider now authenticates a request into an `AuthPrincipal`
 * — a (tenantId, userId) pair plus informational roles — and every storage
 * query is scoped by that tenant as well as the owner.
 *
 * The interface is deliberately tiny and transport-free:
 *
 *   - `authenticate` resolves a verified principal or throws. It never
 *     returns unverified data and never returns a partial principal.
 *   - `mode` names the deployment posture the provider implements, so a host
 *     can refuse to start a multi-tenant provider without tenant scoping.
 *   - nothing about tokens, HTTP, OIDC, or cookies lives here; those belong
 *     to implementations (`@do-sift/auth`, `@do-sift/plugin-auth-oidc`).
 *
 * Implementations must fail closed: missing credentials, an unverified
 * token, a missing tenant claim, or an unknown tenant all refuse — never a
 * default tenant chosen on the caller's behalf.
 */
import { z } from "zod";

/** Deployment postures a provider may implement. */
export const AUTH_MODES = ["owner-allowlist", "multi-tenant"] as const;
export const AuthMode = z.enum(AUTH_MODES);
export type AuthMode = z.infer<typeof AuthMode>;

/**
 * Tenant that existing single-owner deployments are migrated into (plan 024).
 * Every pre-tenant row is backfilled to it, so an upgrade is a no-op for the
 * allowlist deployment shape.
 */
export const DEFAULT_TENANT_ID = "default";

/** Upper bounds mirror the ones used by `packages/kernel` manifests. */
export const AUTH_PRINCIPAL_MAX_ROLES = 32;
export const AUTH_ROLE_MAX_LENGTH = 64;

/**
 * Verified principal. `tenantId` scopes storage; `userId` identifies the
 * person inside that tenant. Roles are advisory labels carried for callers
 * that map them to capability grants — they never grant anything by
 * themselves.
 */
export const AuthPrincipalSchema = z
  .object({
    tenantId: z.string().min(1).max(128),
    userId: z.string().min(1).max(256),
    roles: z
      .array(z.string().min(1).max(AUTH_ROLE_MAX_LENGTH))
      .max(AUTH_PRINCIPAL_MAX_ROLES)
      .default([]),
  })
  .strict();

export interface AuthPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Transport-neutral credentials a provider may inspect. */
export interface AuthProviderRequest {
  /** Bearer token, raw and unparsed; absent means "no credential offered". */
  token?: string | undefined;
  /** Client address as reported by the server (for loopback dev bypasses). */
  clientAddress?: string | undefined;
}

/**
 * A pluggable authentication provider. The kernel and the server depend on
 * this interface only — never on a concrete implementation.
 */
export interface AuthProvider {
  /** Stable provider id (e.g. "owner-allowlist", "auth-oidc"). */
  readonly id: string;
  /** Deployment posture this provider implements. */
  readonly mode: AuthMode;
  /**
   * Resolve a verified principal, or throw. Implementations must validate
   * every field: no implicit tenants, no unverified subjects.
   */
  authenticate(request: AuthProviderRequest): Promise<AuthPrincipal>;
}

/**
 * Roles a tenant membership may carry. Membership itself is the gate (see
 * `MembershipDirectory`); once admitted, the recorded role narrows what the
 * user may do (`roleAllows`, MT-12).
 */
export const TENANT_ROLES = ["owner", "member", "viewer"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
export const TenantRoleSchema = z.enum(TENANT_ROLES);

/**
 * What an admitted member may do (issue #120, plan 024 — MT-12).
 *
 *   - `read` — non-billable surfaces: the landing page and metrics.
 *   - `research` — the run surfaces that reserve budget and write evidence
 *     (`POST /api/research`, `POST /api/answer`).
 *   - `admin` — membership administration (`/api/admin/*`).
 *
 * The mapping is deliberately additive and small: a `viewer` is read-only, a
 * `member` may run research, and only an `owner` administers. Anything not
 * listed is refused, so a new action is opt-in rather than silently granted.
 */
export const TENANT_ROLE_ACTIONS = ["read", "research", "admin"] as const;
export type TenantRoleAction = (typeof TENANT_ROLE_ACTIONS)[number];

const ROLE_ACTIONS: Readonly<Record<TenantRole, readonly TenantRoleAction[]>> = {
  owner: ["read", "research", "admin"],
  member: ["read", "research"],
  viewer: ["read"],
};

/**
 * Whether a recorded role permits an action. An absent role (no membership)
 * permits nothing — the decision fails closed rather than defaulting to a
 * role. Never call this with a role taken from a token claim: roles here come
 * from the `tenant_members` record.
 */
export function roleAllows(role: TenantRole | undefined, action: TenantRoleAction): boolean {
  if (role === undefined) return false;
  return ROLE_ACTIONS[role].includes(action);
}

/**
 * Kinds of membership change the audit log records. `added` is a first grant,
 * `role-changed` an existing row moving roles, `removed` a dropped row.
 */
export const TENANT_MEMBER_CHANGE_ACTIONS = ["added", "role-changed", "removed"] as const;
export type TenantMemberChangeAction = (typeof TENANT_MEMBER_CHANGE_ACTIONS)[number];

/**
 * One recorded membership change (migration 0012, plan 024 — MT-10). The log
 * is append-only: it answers "who changed whose role, when, and from what"
 * for an owner reviewing their tenant after the fact.
 */
export interface TenantMemberChange {
  /** Monotonic log id; larger is newer. */
  id: number;
  tenantId: string;
  /** The user who performed the change (an owner, or `system` for scripts). */
  actorUserId: string;
  /** The membership row that was changed. */
  targetUserId: string;
  action: TenantMemberChangeAction;
  /** Role before the change; absent for a first grant. */
  fromRole?: TenantRole | undefined;
  /** Role after the change; absent for a removal. */
  toRole?: TenantRole | undefined;
  /** ISO-8601 timestamp of the change. */
  at: string;
}

/**
 * Authoritative answer to "may this user act inside this tenant?".
 *
 * The membership table (migration 0011) is the record; a provider's tenant
 * claim is only a *request* to act in a tenant. Everything that turns a
 * principal into data access — kernel grants and per-tenant runtimes —
 * consults this directory first, so a valid token for tenant A cannot be
 * replayed against tenant B.
 */
export interface MembershipDirectory {
  /** The user's role in the tenant, or undefined when they are not a member. */
  roleOf(tenantId: string, userId: string): Promise<TenantRole | undefined>;
}

/**
 * Validate a principal produced by a provider. Providers call this before
 * returning so a malformed identity can never reach storage.
 */
export function parseAuthPrincipal(value: unknown): AuthPrincipal {
  return AuthPrincipalSchema.parse(value);
}

/** Tenant-scoped storage key suffix: `<tenantId>/<userId>` (diagnostics only). */
export function principalLabel(principal: Pick<AuthPrincipal, "tenantId" | "userId">): string {
  return `${principal.tenantId}/${principal.userId}`;
}
