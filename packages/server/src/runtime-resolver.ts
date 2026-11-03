/**
 * Per-tenant runtime resolution (issue #120, plan 024 — MT-07).
 *
 * `createRuntime` composes one tenant-bound runtime. A process that serves
 * several tenants needs one of those per tenant, sharing the expensive parts
 * (database client, search adapter, fetch path, model, embedder) while
 * keeping repositories and ledgers strictly separate.
 *
 * Two layers, both fail closed:
 *
 *   1. `createRuntimeResolver` builds and memoizes one runtime per tenant,
 *      refuses tenants outside the configured set, and bounds how many it
 *      will hold (an unbounded map is a denial-of-service surface).
 *   2. `resolvePrincipalRuntime` checks the authenticated principal against
 *      the membership record *before* resolving — a valid token for tenant A
 *      is not authority to reach tenant B's runtime, even with a forged or
 *      stale tenant claim.
 *
 * Concurrency: concurrent requests for the same tenant share one in-flight
 * creation rather than racing to build duplicate harnesses.
 */
import type { MembershipDirectory } from "@do-sift/contracts";
import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.js";

/** Default ceiling on runtimes held by one process (memory/latency bound). */
export const DEFAULT_MAX_RESOLVED_TENANTS = 32;

export interface RuntimeResolverOptions extends Omit<RuntimeOptions, "tenantId"> {
  /**
   * Tenants this process serves. Non-empty is exhaustive: any other tenant is
   * refused as unknown. Empty/omitted accepts any tenant up to `maxTenants`
   * (single-tenant callers that never pass one).
   */
  tenantIds?: readonly string[] | undefined;
  /** Ceiling on resolved runtimes; default `DEFAULT_MAX_RESOLVED_TENANTS`. */
  maxTenants?: number | undefined;
}

export type TenantAccessFailure = "not-a-member" | "unknown-tenant" | "too-many-tenants";

/** A tenant the caller may not reach. The HTTP layer maps this to 403. */
export class TenantAccessError extends Error {
  constructor(
    public readonly kind: TenantAccessFailure,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "TenantAccessError";
  }
}

export interface RuntimeResolver {
  /** The configured tenant set (sorted); empty means "any tenant". */
  readonly tenantIds: readonly string[];
  /** How many runtimes are currently held. */
  readonly size: number;
  /** Whether this resolver is configured to serve the tenant. */
  has(tenantId: string): boolean;
  /** The already-built runtime for a tenant, if any (never creates one). */
  get(tenantId: string): Runtime | undefined;
  /** Build (or reuse) the tenant's runtime; rejects `TenantAccessError`. */
  resolve(tenantId: string): Promise<Runtime>;
}

function normalizeTenantIds(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const ids = new Set<string>();
  for (const entry of raw) {
    const id = entry.trim();
    if (id === "") {
      throw new Error("tenantIds entries must be non-empty tenant ids");
    }
    if (id.includes("/")) {
      throw new Error(`tenant id "${id}" must not contain "/" (it keys diagnostics)`);
    }
    ids.add(id);
  }
  return [...ids].sort();
}

export async function createRuntimeResolver(
  options: RuntimeResolverOptions,
): Promise<RuntimeResolver> {
  // Everything except the resolver-only options feeds `createRuntime`.
  const { tenantIds: rawTenantIds, maxTenants: rawMaxTenants, ...runtimeOptions } = options;
  const tenantIds = normalizeTenantIds(rawTenantIds);
  const known = new Set(tenantIds);
  const maxTenants = rawMaxTenants ?? DEFAULT_MAX_RESOLVED_TENANTS;
  if (!Number.isInteger(maxTenants) || maxTenants < 1) {
    throw new Error(`maxTenants must be a positive integer (got ${String(rawMaxTenants)})`);
  }
  const runtimes = new Map<string, Runtime>();
  const pending = new Map<string, Promise<Runtime>>();

  const permitted = (tenantId: string): boolean =>
    tenantId !== "" && (known.size === 0 || known.has(tenantId));

  const resolve = (rawTenantId: string): Promise<Runtime> => {
    const tenantId = rawTenantId.trim();
    if (tenantId === "") {
      return Promise.reject(new TenantAccessError("unknown-tenant", "tenant id must not be empty"));
    }
    if (!permitted(tenantId)) {
      return Promise.reject(
        new TenantAccessError(
          "unknown-tenant",
          `tenant "${tenantId}" is not served by this process`,
        ),
      );
    }
    const existing = runtimes.get(tenantId);
    if (existing !== undefined) return Promise.resolve(existing);
    const inFlight = pending.get(tenantId);
    if (inFlight !== undefined) return inFlight;
    if (runtimes.size + pending.size >= maxTenants) {
      return Promise.reject(
        new TenantAccessError(
          "too-many-tenants",
          `refusing to serve more than ${maxTenants} tenants from one process`,
        ),
      );
    }
    const created = createRuntime({ ...runtimeOptions, tenantId }).then(
      (runtime) => {
        runtimes.set(tenantId, runtime);
        pending.delete(tenantId);
        return runtime;
      },
      (error: unknown) => {
        pending.delete(tenantId);
        throw error;
      },
    );
    pending.set(tenantId, created);
    return created;
  };

  return {
    tenantIds,
    get size() {
      return runtimes.size;
    },
    has: (tenantId) => permitted(tenantId.trim()),
    get: (tenantId) => runtimes.get(tenantId.trim()),
    resolve,
  };
}

export interface PrincipalRuntimeRequest {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PrincipalRuntimeDeps {
  resolver: RuntimeResolver;
  /** Authoritative membership record (e.g. `TenantMembershipDirectory`). */
  membership: MembershipDirectory;
  principal: PrincipalRuntimeRequest;
}

/**
 * Resolve the runtime a principal may use: membership first, then the
 * tenant's runtime. Rejects with `TenantAccessError("not-a-member")` rather
 * than falling back to any other tenant.
 */
export async function resolvePrincipalRuntime(deps: PrincipalRuntimeDeps): Promise<Runtime> {
  const { tenantId, userId } = deps.principal;
  const role = await deps.membership.roleOf(tenantId, userId);
  if (role === undefined) {
    throw new TenantAccessError("not-a-member", `user is not a member of tenant "${tenantId}"`);
  }
  return deps.resolver.resolve(tenantId);
}
