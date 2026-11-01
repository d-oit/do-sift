/**
 * Tenant scoping for the storage layer (#120, ADR 0010).
 *
 * Every repository instance is bound to exactly one tenant. The binding is
 * applied to every query it issues — reads filter on `tenant_id`, writes
 * stamp it — so a repository can never return or mutate another tenant's
 * evidence, runs, or configuration. The legacy single-owner deployment maps
 * to the `default` tenant, which is also the column default, so existing
 * rows and the owner-allowlist mode keep their exact behaviour.
 *
 * Fail closed: an empty, oversized, or malformed tenant id throws before any
 * SQL runs (a claim can never smuggle a separator into a query).
 */
import { TenantId } from "@do-sift/contracts";

/** Scope of a single-owner / pre-multi-tenant deployment. */
export const DEFAULT_TENANT = "default";

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

/** Validate and return a tenant id, throwing `TenantScopeError` otherwise. */
export function assertTenantId(value: string): string {
  const parsed = TenantId.safeParse(value);
  if (!parsed.success) {
    throw new TenantScopeError(
      `invalid tenant id ${JSON.stringify(value)}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

export interface TenantFilter {
  /** SQL fragment to append: `" AND tenant_id = ?"` (empty alias omitted). */
  readonly sql: string;
  readonly args: readonly string[];
}

/**
 * Build the tenant predicate for a query. `alias` qualifies the column for
 * joined queries (e.g. `p` → `p.tenant_id`). Always parameterised — the id
 * is never interpolated into SQL text.
 */
export function tenantFilter(tenantId: string, alias?: string): TenantFilter {
  const column = alias === undefined || alias === "" ? "tenant_id" : `${alias}.tenant_id`;
  return { sql: ` AND ${column} = ?`, args: [tenantId] };
}
