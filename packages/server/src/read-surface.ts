/**
 * Read-only surface (issue #120, plan 024 — MT-13).
 *
 * MT-12 made `viewer` read-only, but a read-only role with nothing to read is
 * not an access level — it is a lockout. These two routes let any member of a
 * tenant review what that tenant has already stored, without running research,
 * reserving budget, or writing a row.
 *
 * Order of checks, all fail-closed:
 *
 *   1. method (`GET` only) and no request body;
 *   2. authentication (401);
 *   3. the *recorded* role, when the host supplies one — `read` is the one
 *      action every role has, but an absent membership has no role at all and
 *      is refused (403);
 *   4. owner scoping: the owner id is the authenticated caller's own, so one
 *      member can never page through another member's corpus. The tenant comes
 *      from the principal too, never from the query string.
 *
 * Nothing here accepts an id from the request: there is no `?owner=` and no
 * cross-tenant path to tamper with.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_TENANT_ID, roleAllows } from "@do-sift/contracts";
import type {
  AuthenticatedRequestOwner,
  ReadCursor,
  ReadHandlers,
  ResearchServerOptions,
} from "./server-contracts.js";
import { jsonError, rejectBodyOnBodylessRoute, respondAuthFailure } from "./server-http.js";

/** Newest stored sources of the caller's own corpus. */
export const EVIDENCE_PATH = "/api/evidence";
/** Newest stored answers (id, question, flags) of the caller's own corpus. */
export const ANSWERS_PATH = "/api/answers";
/** Page size when `limit` is omitted. */
export const READ_DEFAULT_LIMIT = 20;
/** Largest page a caller may request; larger values are a `400`, not clamped. */
export const READ_MAX_LIMIT = 50;

/** Whether a raw path belongs to the read-only surface (dispatch predicate). */
export function isReadPath(path: string): boolean {
  return path === EVIDENCE_PATH || path === ANSWERS_PATH;
}

/**
 * Page size from `?limit=`. Out-of-range values are an error rather than a
 * silent clamp: a client that asks for 500 should learn it got 50 only if it
 * asked for 50.
 */
function parseLimit(rawUrl: string | undefined): number {
  if (rawUrl === undefined || rawUrl === "") return READ_DEFAULT_LIMIT;
  const raw = new URL(rawUrl, "http://localhost").searchParams.get("limit");
  if (raw === null) return READ_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${READ_MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Page cursor from `?cursor=`: base64url of `[at, id]`, the ordering key of
 * the last row the caller already received. It is not a token and carries no
 * authority — the query still filters on the authenticated owner and tenant, so
 * a forged cursor can only move the window inside the caller's own rows. A
 * malformed one is a `400` rather than a silently ignored parameter.
 */
function parseCursor(rawUrl: string | undefined): ReadCursor | undefined {
  if (rawUrl === undefined || rawUrl === "") return undefined;
  const raw = new URL(rawUrl, "http://localhost").searchParams.get("cursor");
  if (raw === null) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("cursor is not a value this server issued");
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new Error("cursor is not a value this server issued");
  }
  const [at, id] = decoded as unknown[];
  if (typeof at !== "string" || typeof id !== "string") {
    throw new Error("cursor is not a value this server issued");
  }
  if (at === "" || at.length > 64 || id === "" || id.length > 128) {
    throw new Error("cursor is not a value this server issued");
  }
  return { at, id };
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}

export async function handleReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  path: string,
  httpRequestId: string,
): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }
  if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  let owner: AuthenticatedRequestOwner;
  try {
    owner = await options.auth.authenticateOwner({
      token,
      clientAddress: req.socket.remoteAddress ?? "",
    });
  } catch (e) {
    respondAuthFailure(res, e, httpRequestId, req);
    return;
  }

  if (options.roleFor !== undefined) {
    const role = await options.roleFor({
      tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
      userId: owner.ownerId,
    });
    if (!roleAllows(role, "read")) {
      jsonError(res, 403, "forbidden", httpRequestId, req);
      return;
    }
  }

  // Resolve the tenant-bound read handlers only after the caller is admitted:
  // a refused caller never reaches storage at all.
  const principal = {
    tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
    userId: owner.ownerId,
  };
  const readFor = options.readFor;
  if (readFor === undefined) {
    jsonError(res, 404, "not found", httpRequestId, req);
    return;
  }
  const handlers: ReadHandlers = await readFor(principal);

  let limit: number;
  try {
    limit = parseLimit(req.url);
  } catch {
    jsonError(res, 400, "limit must be an integer between 1 and 50", httpRequestId, req);
    return;
  }

  let cursor: ReadCursor | undefined;
  try {
    cursor = parseCursor(req.url);
  } catch {
    jsonError(res, 400, "cursor is not a value this server issued", httpRequestId, req);
    return;
  }

  // One extra row tells us whether another page exists, so a page that exactly
  // fills the request does not promise a next page that turns out empty.
  const pageSize = limit + 1;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };

  if (path === EVIDENCE_PATH) {
    const rows = await handlers.evidence(owner.ownerId, pageSize, cursor);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined ? encodeCursor(last.fetchedAt, last.id) : undefined;
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({ evidence: page, ...(nextCursor === undefined ? {} : { nextCursor }) }),
    );
    return;
  }

  const rows = await handlers.answers(owner.ownerId, pageSize, cursor);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : undefined;
  res.writeHead(200, headers);
  res.end(JSON.stringify({ answers: page, ...(nextCursor === undefined ? {} : { nextCursor }) }));
}
