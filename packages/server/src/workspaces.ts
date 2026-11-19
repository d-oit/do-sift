/**
 * Authenticated research-workspace routes (issues #168/#169).
 *
 * Two surfaces share this module:
 *
 *   /api/collections*  — collections, item references, and owner notes
 *   /api/compare       — side-by-side comparison of stored passages
 *
 * Both are metadata views over rows the caller already owns. Neither fetches,
 * neither calls a model, and neither accepts an owner or tenant id from the
 * request: the principal comes from the authenticator, and the host builds a
 * tenant/owner-bound handler set from it. Reads require `read`, writes require
 * `research` when a recorded role policy is configured.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_TENANT_ID, roleAllows, type TenantRoleAction } from "@do-sift/contracts";
import type {
  AuthenticatedRequestOwner,
  CollectionNoteView,
  CollectionView,
  CollectionsHandlers,
  CompareHandlers,
  ResearchServerOptions,
} from "./server-contracts.js";
import { compareEvidence, ComparisonError } from "./compare.js";
import { COLLECTION_DESCRIPTION_MAX, COLLECTION_TITLE_MAX } from "@do-sift/storage";
import {
  HttpRequestError,
  assertJsonContentType,
  jsonError,
  readBody,
  rejectBodyOnBodylessRoute,
  respondAuthFailure,
} from "./server-http.js";

export const COLLECTIONS_PATH = "/api/collections";
export const COLLECTIONS_PREFIX = "/api/collections/";
export const COMPARE_PATH = "/api/compare";

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ITEM_KINDS = ["run", "evidence"] as const;
type ItemKind = (typeof ITEM_KINDS)[number];

/** Whether a raw path belongs to the workspace surface (dispatch predicate). */
export function isWorkspacePath(path: string): boolean {
  return path === COMPARE_PATH || path === COLLECTIONS_PATH || path.startsWith(COLLECTIONS_PREFIX);
}

type WorkspaceRoute =
  | { kind: "collections" }
  | { kind: "collection"; id: string }
  | { kind: "items"; id: string }
  | { kind: "item"; id: string; itemKind: ItemKind; itemId: string }
  | { kind: "notes"; id: string }
  | { kind: "note"; id: string; noteId: string }
  | { kind: "compare" };

/** Parse a path already accepted by `requestPath`; undefined means 404. */
export function parseWorkspaceRoute(path: string): WorkspaceRoute | undefined {
  if (path === COMPARE_PATH) return { kind: "compare" };
  if (path === COLLECTIONS_PATH) return { kind: "collections" };
  if (!path.startsWith(COLLECTIONS_PREFIX)) return undefined;
  const segments = path.slice(COLLECTIONS_PREFIX.length).split("/");
  const [id, sub, third, fourth] = segments;
  if (id === undefined || !ID.test(id)) return undefined;
  if (segments.length === 1) return { kind: "collection", id };
  if (segments.length === 2 && sub === "items") return { kind: "items", id };
  if (segments.length === 2 && sub === "notes") return { kind: "notes", id };
  if (segments.length === 4 && sub === "items") {
    if (third === undefined || !(ITEM_KINDS as readonly string[]).includes(third)) return undefined;
    if (fourth === undefined || !ID.test(fourth)) return undefined;
    return { kind: "item", id, itemKind: third as ItemKind, itemId: fourth };
  }
  if (segments.length === 3 && sub === "notes") {
    if (third === undefined || !ID.test(third)) return undefined;
    return { kind: "note", id, noteId: third };
  }
  return undefined;
}

function json(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ ...(payload as object), requestId }));
}

function noContent(res: ServerResponse, requestId: string): void {
  res.writeHead(204, { "cache-control": "no-store", "x-request-id": requestId });
  res.end();
}

function allow(res: ServerResponse, methods: readonly string[]): void {
  res.setHeader("allow", methods.join(", "));
}

async function readJsonObject(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  assertJsonContentType(req);
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, maxBytes)) as unknown;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpRequestError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpRequestError(400, `${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpRequestError(400, `${key} must be ${min}..${max} characters`);
  }
  return trimmed;
}

function collectionView(row: {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | undefined;
}): CollectionView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.archivedAt === undefined ? {} : { archivedAt: row.archivedAt }),
  };
}

function noteView(note: {
  id: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}): CollectionNoteView {
  return {
    id: note.id,
    body: note.body,
    authorId: note.authorId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function parseLimit(rawUrl: string | undefined, fallback: number, max: number): number {
  const raw =
    rawUrl === undefined ? null : new URL(rawUrl, "http://localhost").searchParams.get("limit");
  if (raw === null) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new HttpRequestError(400, `limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

function encodeItemCursor(item: { addedAt: string; kind: "run" | "evidence"; id: string }): string {
  return Buffer.from(JSON.stringify([item.addedAt, item.kind, item.id]), "utf8").toString(
    "base64url",
  );
}

/** Decode an opaque item cursor; malformed input is a 400, never ignored. */
function parseItemCursor(
  rawUrl: string | undefined,
): { addedAt: string; kind: "run" | "evidence"; id: string } | undefined {
  if (rawUrl === undefined) return undefined;
  const raw = new URL(rawUrl, "http://localhost").searchParams.get("cursor");
  if (raw === null || raw === "") return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError(400, "cursor is not a value this server issued");
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) {
    throw new HttpRequestError(400, "cursor is not a value this server issued");
  }
  const [addedAt, kind, id] = decoded as unknown[];
  if (
    typeof addedAt !== "string" ||
    addedAt === "" ||
    addedAt.length > 64 ||
    typeof kind !== "string" ||
    !(ITEM_KINDS as readonly string[]).includes(kind) ||
    typeof id !== "string" ||
    id === "" ||
    id.length > 128
  ) {
    throw new HttpRequestError(400, "cursor is not a value this server issued");
  }
  return { addedAt, kind: kind as "run" | "evidence", id };
}

function requireId(raw: string | undefined, label: string): string {
  if (raw === undefined || !ID.test(raw)) {
    throw new HttpRequestError(400, `${label} is not a valid id`);
  }
  return raw;
}

export async function handleWorkspaceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  path: string,
  httpRequestId: string,
): Promise<void> {
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

  const principal = {
    tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
    userId: owner.ownerId,
  };

  const route = parseWorkspaceRoute(path);
  if (route === undefined) {
    jsonError(res, 404, "not found", httpRequestId, req);
    return;
  }

  // Comparison is a read even though it uses POST for a bounded id list; a
  // viewer may use it. Collection writes require the research action.
  const isRead = route.kind === "compare" || req.method === "GET";
  const action: TenantRoleAction = isRead ? "read" : "research";
  if (options.roleFor !== undefined) {
    const role = await options.roleFor(principal);
    if (!roleAllows(role, action)) {
      jsonError(res, 403, "forbidden", httpRequestId, req);
      return;
    }
  }

  try {
    if (route.kind === "compare") {
      await handleCompare(req, res, options.compareFor, principal, owner.ownerId, httpRequestId);
      return;
    }
    await handleCollections(
      req,
      res,
      options.collectionsFor,
      principal,
      owner.ownerId,
      route,
      httpRequestId,
      options.maxBodyBytes ?? 8192,
    );
  } catch (error) {
    if (error instanceof HttpRequestError) {
      jsonError(res, error.status, error.message, httpRequestId, req);
      return;
    }
    if (error instanceof ComparisonError) {
      jsonError(res, 400, error.message, httpRequestId, req);
      return;
    }
    console.error(`[${httpRequestId}] workspace route failed: ${String(error)}`);
    jsonError(res, 500, "internal error", httpRequestId, req);
  }
}

async function handleCompare(
  req: IncomingMessage,
  res: ServerResponse,
  compareFor: ResearchServerOptions["compareFor"],
  principal: { tenantId: string; userId: string },
  ownerId: string,
  httpRequestId: string,
): Promise<void> {
  if (req.method !== "POST") {
    allow(res, ["POST"]);
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }
  if (compareFor === undefined) {
    jsonError(res, 404, "not found", httpRequestId, req);
    return;
  }
  const body = await readJsonObject(req, 64 * 1024);
  const raw = body["ids"];
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) {
    throw new HttpRequestError(400, "ids must be an array of 2..8 evidence ids");
  }
  const ids = raw.map((value) =>
    requireId(typeof value === "string" ? value : undefined, "evidence id"),
  );
  if (new Set(ids).size !== ids.length) {
    throw new HttpRequestError(400, "ids must be distinct");
  }
  const handlers: CompareHandlers = await compareFor(principal);
  const sources = await handlers.sources(ownerId, ids);
  if (sources.length !== ids.length) {
    const known = new Set(sources.map((source) => source.evidenceId));
    const missing = ids.filter((id) => !known.has(id));
    jsonError(
      res,
      404,
      `unknown evidence id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      httpRequestId,
      req,
    );
    return;
  }
  json(res, 200, { comparison: compareEvidence(sources, ids) }, httpRequestId);
}

async function handleCollections(
  req: IncomingMessage,
  res: ServerResponse,
  collectionsFor: ResearchServerOptions["collectionsFor"],
  principal: { tenantId: string; userId: string },
  ownerId: string,
  route: Exclude<WorkspaceRoute, { kind: "compare" }>,
  httpRequestId: string,
  maxBodyBytes: number,
): Promise<void> {
  if (collectionsFor === undefined) {
    jsonError(res, 404, "not found", httpRequestId, req);
    return;
  }
  const handlers: CollectionsHandlers = await collectionsFor(principal);

  if (route.kind === "collections") {
    if (req.method === "GET") {
      if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
      const limit = parseLimit(req.url, 50, 100);
      const includeArchived =
        new URL(req.url ?? "/", "http://localhost").searchParams.get("includeArchived") === "true";
      const rows = await handlers.list(ownerId, { limit, includeArchived });
      json(res, 200, { collections: rows.map(collectionView) }, httpRequestId);
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonObject(req, maxBodyBytes);
      const title = stringField(body, "title", 1, COLLECTION_TITLE_MAX);
      const description =
        body["description"] === undefined
          ? ""
          : stringField(body, "description", 0, COLLECTION_DESCRIPTION_MAX);
      const created = await handlers.create(ownerId, { title, description });
      json(res, 201, { collection: collectionView(created) }, httpRequestId);
      return;
    }
    allow(res, ["GET", "POST"]);
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }

  if (route.kind === "collection") {
    if (req.method === "GET") {
      if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
      const detail = await handlers.get(ownerId, route.id);
      if (detail === undefined) {
        jsonError(res, 404, "not found", httpRequestId, req);
        return;
      }
      const totalItems = detail.totalItems ?? detail.items.length;
      const last = detail.items[detail.items.length - 1];
      const nextCursor =
        detail.items.length < totalItems && last !== undefined ? encodeItemCursor(last) : undefined;
      json(
        res,
        200,
        {
          collection: collectionView(detail.collection),
          items: detail.items,
          totalItems,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          notes: detail.notes.map(noteView),
        },
        httpRequestId,
      );
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonObject(req, maxBodyBytes);
      const changes: { title?: string; description?: string } = {};
      if (body["title"] !== undefined)
        changes.title = stringField(body, "title", 1, COLLECTION_TITLE_MAX);
      if (body["description"] !== undefined) {
        changes.description = stringField(body, "description", 0, COLLECTION_DESCRIPTION_MAX);
      }
      if (changes.title === undefined && changes.description === undefined) {
        throw new HttpRequestError(400, "PATCH needs a title or description");
      }
      const updated = await handlers.update(ownerId, route.id, changes);
      if (!updated) {
        jsonError(res, 404, "not found", httpRequestId, req);
        return;
      }
      json(res, 200, { updated: true }, httpRequestId);
      return;
    }
    if (req.method === "DELETE") {
      if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
      const archived = await handlers.archive(ownerId, route.id);
      if (!archived) {
        jsonError(res, 404, "not found", httpRequestId, req);
        return;
      }
      json(res, 200, { archived: true }, httpRequestId);
      return;
    }
    allow(res, ["GET", "PATCH", "DELETE"]);
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }

  if (route.kind === "items") {
    if (req.method === "GET") {
      if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
      const limit = parseLimit(req.url, 50, 100);
      const cursor = parseItemCursor(req.url);
      const page = await handlers.items(ownerId, route.id, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page === undefined) {
        jsonError(res, 404, "not found", httpRequestId, req);
        return;
      }
      const last = page.items[page.items.length - 1];
      const nextCursor = page.hasMore && last !== undefined ? encodeItemCursor(last) : undefined;
      json(
        res,
        200,
        {
          items: page.items,
          totalItems: page.totalItems,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        httpRequestId,
      );
      return;
    }
    if (req.method !== "POST") {
      allow(res, ["GET", "POST"]);
      jsonError(res, 405, "method not allowed", httpRequestId, req);
      return;
    }
    const body = await readJsonObject(req, maxBodyBytes);
    const kind = body["kind"];
    if (kind !== "run" && kind !== "evidence") {
      throw new HttpRequestError(400, 'kind must be "run" or "evidence"');
    }
    const itemId = requireId(typeof body["id"] === "string" ? body["id"] : undefined, "item id");
    const detail = await handlers.get(ownerId, route.id);
    if (detail === undefined) {
      jsonError(res, 404, "not found", httpRequestId, req);
      return;
    }
    if (detail.collection.archivedAt !== undefined) {
      jsonError(res, 409, "collection is archived", httpRequestId, req);
      return;
    }
    await handlers.addItem(ownerId, route.id, kind, itemId);
    noContent(res, httpRequestId);
    return;
  }

  if (route.kind === "item") {
    if (req.method !== "DELETE") {
      allow(res, ["DELETE"]);
      jsonError(res, 405, "method not allowed", httpRequestId, req);
      return;
    }
    if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
    const removed = await handlers.removeItem(ownerId, route.id, route.itemKind, route.itemId);
    if (!removed) {
      jsonError(res, 404, "not found", httpRequestId, req);
      return;
    }
    noContent(res, httpRequestId);
    return;
  }

  if (route.kind === "notes") {
    if (req.method === "GET") {
      if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
      const notes = await handlers.notes(ownerId, route.id);
      json(res, 200, { notes: notes.map(noteView) }, httpRequestId);
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonObject(req, maxBodyBytes);
      const noteBody = stringField(body, "body", 1, 8000);
      const detail = await handlers.get(ownerId, route.id);
      if (detail === undefined) {
        jsonError(res, 404, "not found", httpRequestId, req);
        return;
      }
      const note = await handlers.addNote(ownerId, route.id, noteBody);
      json(res, 201, { note: noteView(note) }, httpRequestId);
      return;
    }
    allow(res, ["GET", "POST"]);
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }

  // route.kind === "note"
  if (req.method !== "DELETE") {
    allow(res, ["DELETE"]);
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }
  if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
  const deleted = await handlers.deleteNote(ownerId, route.id, route.noteId);
  if (!deleted) {
    jsonError(res, 404, "not found", httpRequestId, req);
    return;
  }
  noContent(res, httpRequestId);
}
