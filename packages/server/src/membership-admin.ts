/**
 * Membership administration (issue #120, plan 024 — MT-09).
 *
 * The tenant is always the authenticated principal's own tenant: it is never
 * read from the URL, the body, or a query string, so there is no cross-tenant
 * id to tamper with and no tenant-existence oracle.
 *
 * Authority is the *stored* membership role, not a token claim. A provider's
 * `roles` are arbitrary strings it chose to carry; the `tenant_members` row is
 * the record. Only a recorded `owner` of the tenant may list or change
 * members. Members, viewers, and non-members all get the same `403`, so the
 * response never discloses who is a member.
 *
 * Lockout guard: an owner may not change or remove their own row. That keeps
 * every tenant with at least one owner without a "count the owners" race, and
 * an owner can still demote *another* owner, which leaves themselves.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_TENANT_ID, TENANT_ROLES, type TenantRole } from "@do-sift/contracts";
import { admissionKey, admitOwner } from "./owner-limiter.js";
import type {
  AuthenticatedRequestOwner,
  MembershipAdminHandlers,
  ResearchServerOptions,
} from "./server-contracts.js";
import {
  HttpRequestError,
  assertJsonContentType,
  bindRequestCancellation,
  describeError,
  jsonError,
  readBody,
  rejectBodyOnBodylessRoute,
  respondAuthFailure,
} from "./server-http.js";

/** Collection route; item routes append `/<userId>`. */
export const MEMBERSHIP_ADMIN_PATH = "/api/admin/members";
/** Read-only change log of the caller's own tenant (MT-10). */
export const MEMBERSHIP_ADMIN_CHANGES_PATH = "/api/admin/member-changes";
const ITEM_PREFIX = `${MEMBERSHIP_ADMIN_PATH}/`;
const MAX_MEMBER_ID = 256;

/** Whether a raw path belongs to the admin surface (dispatch predicate). */
export function isMembershipAdminPath(path: string): boolean {
  return (
    path === MEMBERSHIP_ADMIN_PATH ||
    path === MEMBERSHIP_ADMIN_CHANGES_PATH ||
    path.startsWith(ITEM_PREFIX)
  );
}

/**
 * The member id in `/api/admin/members/<id>`, or undefined when the path has
 * no usable id. Percent-encoded separators are rejected after decoding: an id
 * is one path segment, never a nested path.
 */
function parseMemberId(path: string): string | undefined {
  if (!path.startsWith(ITEM_PREFIX)) return undefined;
  const raw = path.slice(ITEM_PREFIX.length);
  if (raw === "" || raw.includes("/")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded === "" || decoded.length > MAX_MEMBER_ID) return undefined;
  if (decoded.includes("/") || /\s/u.test(decoded)) return undefined;
  return decoded;
}

async function readRole(req: IncomingMessage, maxBodyBytes: number): Promise<TenantRole> {
  assertJsonContentType(req);
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, maxBodyBytes)) as unknown;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpRequestError(400, "request body must be a JSON object");
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "role") {
    throw new HttpRequestError(
      400,
      'request body must be exactly {"role": "owner" | "member" | "viewer"}',
    );
  }
  const role = (body as { role?: unknown }).role;
  if (typeof role !== "string" || !(TENANT_ROLES as readonly string[]).includes(role)) {
    throw new HttpRequestError(400, `role must be one of ${TENANT_ROLES.join(", ")}`);
  }
  return role as TenantRole;
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

export interface MembershipAdminRequest {
  req: IncomingMessage;
  res: ServerResponse;
  /** Auth and admission configuration from the research server. */
  options: ResearchServerOptions;
  handlers: MembershipAdminHandlers;
  path: string;
  maxBodyBytes: number;
  httpRequestId: string;
}

/**
 * Serve one admin request: method check, authentication, stored-role
 * authorization, then the operation. Every failure is a bounded JSON error;
 * nothing about the tenant's member list leaks to a caller who is not its
 * recorded owner.
 */
export async function handleMembershipAdmin(args: MembershipAdminRequest): Promise<void> {
  const { req, res, options, handlers, path, maxBodyBytes, httpRequestId } = args;
  const isChanges = path === MEMBERSHIP_ADMIN_CHANGES_PATH;
  const isCollection = path === MEMBERSHIP_ADMIN_PATH;
  const readOnly = isChanges || isCollection;
  const memberId = readOnly ? undefined : parseMemberId(path);

  const method = req.method ?? "";
  const allowed = readOnly ? method === "GET" : method === "PUT" || method === "DELETE";
  if (!allowed) {
    res.setHeader("allow", readOnly ? "GET" : "PUT, DELETE");
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }
  if (method === "GET" && rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  let owner: AuthenticatedRequestOwner;
  try {
    owner = await options.auth.authenticateOwner({
      token,
      clientAddress: req.socket.remoteAddress ?? "",
    });
  } catch (error) {
    respondAuthFailure(res, error, httpRequestId, req);
    return;
  }

  const tenantId = owner.tenantId ?? DEFAULT_TENANT_ID;
  const cancellation = bindRequestCancellation(req, res);
  try {
    if (!admitOwner(options, admissionKey(owner), res, cancellation, httpRequestId, req)) return;
    const callerRole = await handlers.roleOf(tenantId, owner.ownerId);
    if (callerRole !== "owner") {
      jsonError(res, 403, "forbidden", httpRequestId, req);
      return;
    }
    if (cancellation.signal.aborted) return;

    if (method === "GET") {
      if (isChanges) {
        writeJson(res, 200, { tenantId, changes: await handlers.changes(tenantId) });
        return;
      }
      writeJson(res, 200, { tenantId, members: await handlers.list(tenantId) });
      return;
    }

    // Only an authenticated, authorized caller learns that their path id was
    // malformed — the shape of the surface stays invisible to everyone else.
    const targetId = memberId;
    if (targetId === undefined) {
      jsonError(res, 400, "invalid member id in path", httpRequestId, req);
      return;
    }

    // Both mutating methods name a target, and both refuse the caller's own
    // row: self-demotion or self-removal is how a tenant loses its last owner.
    if (targetId === owner.ownerId) {
      jsonError(
        res,
        400,
        method === "PUT"
          ? "cannot change your own membership role"
          : "cannot remove your own membership",
        httpRequestId,
        req,
      );
      return;
    }

    if (method === "PUT") {
      let role: TenantRole;
      try {
        role = await readRole(req, maxBodyBytes);
      } catch (error) {
        if (cancellation.signal.aborted) return;
        if (error instanceof HttpRequestError) {
          jsonError(res, error.status, error.message, httpRequestId, req);
        } else {
          jsonError(res, 400, "bad request", httpRequestId, req);
        }
        return;
      }
      if (cancellation.signal.aborted) return;
      await handlers.upsert(tenantId, targetId, role, owner.ownerId);
      writeJson(res, 200, { tenantId, member: { userId: targetId, role } });
      return;
    }

    const removed = await handlers.remove(tenantId, targetId, owner.ownerId);
    if (!removed) {
      jsonError(res, 404, "member not found", httpRequestId, req);
      return;
    }
    writeJson(res, 200, { tenantId, removed: targetId });
  } catch (error) {
    if (!cancellation.signal.aborted && !res.headersSent) {
      console.error(`[${httpRequestId}] membership admin failed: ${describeError(error)}`);
      jsonError(res, 500, "internal error", httpRequestId, req);
    }
  } finally {
    cancellation.cleanup();
  }
}
