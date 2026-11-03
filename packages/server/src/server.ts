/** Research server: route handlers and composition. Contracts, HTTP plumbing, owner limits, and the landing page live in sibling modules. */
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { DEFAULT_TENANT_ID, roleAllows, type TenantRoleAction } from "@do-sift/contracts";
import type {
  AuthenticatedRequestOwner,
  HttpRequestEvent,
  ResearchServerOptions,
  RuntimeHandlers,
} from "./server-contracts.js";
import { TenantAccessError } from "./runtime-resolver.js";
import { handleMembershipAdmin, isMembershipAdminPath } from "./membership-admin.js";
import { handleReadRoute, isReadPath } from "./read-surface.js";
import {
  HttpRequestError,
  SSE_HEARTBEAT_MS,
  bindRequestCancellation,
  describeError,
  jsonError,
  readQuestion,
  rejectBodyOnBodylessRoute,
  requestPath,
  respondAuthFailure,
  safeMethod,
  sse,
  startReadinessProbe,
} from "./server-http.js";
import type { ReadinessProbe } from "./server-http.js";
import { admissionKey, admitOwner } from "./owner-limiter.js";
import { DEFAULT_PAGE } from "./default-page.js";
export type { SourceCard } from "./server-contracts.js";
export type { ResearchRunOutcome } from "./server-contracts.js";
export type { HttpRequestEvent } from "./server-contracts.js";
export type { AnswerSuspectEvent } from "./server-contracts.js";
export type { AnswerDegradedEvent } from "./server-contracts.js";
export type { OperationalEvent } from "./server-contracts.js";
export type { ResearchServerOptions } from "./server-contracts.js";
export type {
  AuthenticatedRequestOwner,
  MembershipAdminHandlers,
  RuntimeHandlers,
  TenantMemberChangeView,
  TenantMemberView,
} from "./server-contracts.js";
export type { AnswerHttpResponse } from "./server-contracts.js";
export type { OwnerLimits } from "./owner-limiter.js";
export { DEFAULT_REQUEST_DEADLINE_MS } from "./server-http.js";
export { SSE_HEARTBEAT_MS } from "./server-http.js";
export { DEFAULT_OWNER_LIMITS } from "./owner-limiter.js";
export { OwnerLimiter } from "./owner-limiter.js";
/**
 * The run surface for this request: `runtimeFor` when the host routes by
 * tenant, otherwise the single static handler pair.
 */
async function selectRuntimeHandlers(
  options: ResearchServerOptions,
  owner: AuthenticatedRequestOwner,
): Promise<RuntimeHandlers> {
  if (options.runtimeFor !== undefined) {
    return options.runtimeFor({
      tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
      userId: owner.ownerId,
    });
  }
  if (options.runResearch === undefined) {
    throw new Error("research server has no runtime configured");
  }
  return {
    runResearch: options.runResearch,
    ...(options.answer === undefined ? {} : { answer: options.answer }),
  };
}
/**
 * MT-12: the recorded membership role gates the run surfaces. A viewer is
 * read-only, so research and answers answer 403 before a runtime is resolved,
 * any budget is reserved, or any evidence is written. Returns true when the
 * request was refused (and the response is already sent).
 */
async function refuseByRole(
  options: ResearchServerOptions,
  owner: AuthenticatedRequestOwner,
  action: TenantRoleAction,
  res: ServerResponse,
  httpRequestId: string,
  req: IncomingMessage,
): Promise<boolean> {
  if (options.roleFor === undefined) return false;
  const role = await options.roleFor({
    tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
    userId: owner.ownerId,
  });
  if (roleAllows(role, action)) return false;
  jsonError(res, 403, "forbidden", httpRequestId, req);
  return true;
}

/** Tenant refusal is 403 and never leaks whether the tenant exists. */
function respondRuntimeFailure(
  res: ServerResponse,
  error: unknown,
  httpRequestId: string,
  req: IncomingMessage,
): void {
  if (error instanceof TenantAccessError) {
    jsonError(res, 403, "forbidden", httpRequestId, req);
    return;
  }
  console.error(`[${httpRequestId}] runtime selection failed: ${describeError(error)}`);
  jsonError(res, 500, "internal error", httpRequestId, req);
}
async function handleResearch(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  maxBodyBytes: number,
  httpRequestId: string,
): Promise<void> {
  const cancellation = bindRequestCancellation(req, res);
  const canWrite = (): boolean => !res.destroyed && !res.writableEnded;

  try {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    let owner: AuthenticatedRequestOwner;
    try {
      owner = await options.auth.authenticateOwner({
        token,
        clientAddress: req.socket.remoteAddress ?? "",
      });
    } catch (e) {
      if (!cancellation.signal.aborted) {
        respondAuthFailure(res, e, httpRequestId, req);
      }
      return;
    }
    if (cancellation.signal.aborted) return;
    if (await refuseByRole(options, owner, "research", res, httpRequestId, req)) return;

    let handlers: RuntimeHandlers;
    try {
      handlers = await selectRuntimeHandlers(options, owner);
    } catch (e) {
      if (!cancellation.signal.aborted) respondRuntimeFailure(res, e, httpRequestId, req);
      return;
    }

    const ownerId = owner.ownerId;
    if (!admitOwner(options, admissionKey(owner), res, cancellation, httpRequestId, req)) return;

    let question: string;
    try {
      question = await readQuestion(req, maxBodyBytes);
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
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const heartbeat = setInterval(() => {
      if (canWrite() && !cancellation.signal.aborted) res.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const outcome = await handlers.runResearch(
        ownerId,
        question,
        (source) => {
          if (canWrite() && !cancellation.signal.aborted) sse(res, "source", source, httpRequestId);
        },
        cancellation.signal,
      );
      if (canWrite() && !cancellation.signal.aborted) sse(res, "done", outcome, httpRequestId);
    } catch (e) {
      console.error(`[${httpRequestId}] research failed: ${describeError(e)}`);
      if (canWrite() && !cancellation.signal.aborted) {
        sse(res, "error", { message: "research failed" }, httpRequestId);
        // The SSE status is already committed as 200, but the operational
        // receipt must still classify a runner failure as a server error.
        throw e;
      }
    } finally {
      clearInterval(heartbeat);
      if (canWrite()) res.end();
    }
  } finally {
    cancellation.cleanup();
  }
}

async function handleAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  maxBodyBytes: number,
  httpRequestId: string,
): Promise<void> {
  const cancellation = bindRequestCancellation(req, res);
  const canWrite = (): boolean => !res.destroyed && !res.writableEnded;

  try {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    let owner: AuthenticatedRequestOwner;
    try {
      owner = await options.auth.authenticateOwner({
        token,
        clientAddress: req.socket.remoteAddress ?? "",
      });
    } catch (e) {
      if (!cancellation.signal.aborted) {
        respondAuthFailure(res, e, httpRequestId, req);
      }
      return;
    }
    if (cancellation.signal.aborted) return;
    if (await refuseByRole(options, owner, "research", res, httpRequestId, req)) return;

    let handlers: RuntimeHandlers;
    try {
      handlers = await selectRuntimeHandlers(options, owner);
    } catch (e) {
      if (!cancellation.signal.aborted) respondRuntimeFailure(res, e, httpRequestId, req);
      return;
    }

    const answer = handlers.answer;
    if (answer === undefined) {
      // auth passed first: never reveal surface existence to unauthenticated
      // callers, but do tell an authenticated caller the truth.
      jsonError(res, 501, "answer surface not configured", httpRequestId, req);
      return;
    }

    if (!admitOwner(options, admissionKey(owner), res, cancellation, httpRequestId, req)) return;

    let question: string;
    try {
      question = await readQuestion(req, maxBodyBytes);
    } catch (error) {
      if (!cancellation.signal.aborted) {
        if (error instanceof HttpRequestError) {
          jsonError(res, error.status, error.message, httpRequestId, req);
        } else {
          jsonError(res, 400, "bad request", httpRequestId, req);
        }
      }
      return;
    }
    if (cancellation.signal.aborted) return;

    try {
      const payload = await answer(owner.ownerId, question, cancellation.signal);
      if (payload.degraded) {
        // Degradation honesty as a receipt. The service names the cause
        // (no evidence / unresolved citations / provider failure); the
        // block-count fallback keeps older payload producers labeled.
        options.onEvent?.({
          type: "answer.degraded",
          requestId: httpRequestId,
          reason:
            payload.degradationReason ??
            (payload.blocks.length === 0 ? "no-evidence" : "citation-invalid"),
        });
      }
      if (payload.suspectEvidence !== undefined) {
        // ANS-12: advisory receipt for the QUAL gate and live monitoring.
        options.onEvent?.({
          type: "answer.suspect",
          requestId: httpRequestId,
          passages: payload.suspectEvidence.passages,
          markers: payload.suspectEvidence.markers,
        });
      }
      if (!cancellation.signal.aborted && canWrite()) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(payload));
      }
    } catch (e) {
      if (!cancellation.signal.aborted && canWrite()) {
        console.error(`[${httpRequestId}] answer failed: ${describeError(e)}`);
        jsonError(res, 500, "internal error", httpRequestId, req);
      }
    }
  } finally {
    cancellation.cleanup();
  }
}

export function createResearchServer(rawOptions: ResearchServerOptions): Server {
  if (rawOptions.runResearch === undefined && rawOptions.runtimeFor === undefined) {
    throw new Error("createResearchServer needs runResearch or runtimeFor");
  }
  // #67: every operational event feeds the optional metrics registry before
  // the caller's onEvent sink; metrics never alter request behavior.
  const options: ResearchServerOptions =
    rawOptions.metrics === undefined
      ? rawOptions
      : {
          ...rawOptions,
          onEvent: (event) => {
            try {
              rawOptions.metrics?.observe(event);
            } finally {
              rawOptions.onEvent?.(event);
            }
          },
        };
  const maxBodyBytes = options.maxBodyBytes ?? 8192;
  let readinessInFlight: ReadinessProbe | undefined;
  const probeReadiness = async (): Promise<boolean> => {
    if (readinessInFlight === undefined) {
      const current = startReadinessProbe(options.readiness ?? (() => true));
      readinessInFlight = current;
      void current.settled.finally(() => {
        if (readinessInFlight === current) readinessInFlight = undefined;
      });
    }
    return readinessInFlight.result;
  };
  return createHttpServer((req, res) => {
    const httpRequestId = randomUUID();
    const path = requestPath(req.url);
    const startedAt = Date.now();
    let failed = false;
    let clientAborted = false;
    const markClientAborted = (): void => {
      if (!res.writableEnded) clientAborted = true;
    };
    req.once("aborted", markClientAborted);
    res.once("close", markClientAborted);
    res.setHeader("x-request-id", httpRequestId);
    res.setHeader("x-content-type-options", "nosniff");

    const emit = (): void => {
      const status = res.statusCode;
      const outcome: HttpRequestEvent["outcome"] = failed
        ? "server_error"
        : clientAborted
          ? "canceled"
          : status === 501
            ? "unavailable"
            : status >= 500
              ? "server_error"
              : status >= 400
                ? "client_error"
                : "success";
      try {
        if (options.onEvent !== undefined) {
          options.onEvent({
            type: "http.request",
            requestId: httpRequestId,
            method: safeMethod(req.method),
            path,
            status,
            outcome,
            durationMs: Math.max(0, Date.now() - startedAt),
          });
        }
      } catch {
        // Operational logging must never change request behavior.
      } finally {
        req.off("aborted", markClientAborted);
        res.off("close", markClientAborted);
      }
    };

    void (async () => {
      // Liveness (constant, no data) and readiness (dependency probe) are
      // intentionally separate endpoints for orchestrators.
      if (req.method === "GET" && path === "/healthz") {
        if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && path === "/readyz") {
        if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
        const ready = await probeReadiness();
        res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: ready }));
        return;
      }
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        if (rejectBodyOnBodylessRoute(req, res, httpRequestId)) return;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(options.pageHtml ?? DEFAULT_PAGE);
        return;
      }
      if (path === "/metrics" && options.metrics !== undefined) {
        if (req.method !== "GET") {
          res.setHeader("allow", "GET");
          jsonError(res, 405, "method not allowed", httpRequestId, req);
          return;
        }
        const authHeader = req.headers.authorization ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
        try {
          await options.auth.authenticateOwner({
            token,
            clientAddress: req.socket.remoteAddress ?? "",
          });
        } catch (e) {
          respondAuthFailure(res, e, httpRequestId, req);
          return;
        }
        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(options.metrics.render());
        return;
      }
      if (path === "/api/research") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          jsonError(res, 405, "method not allowed", httpRequestId, req);
          return;
        }
        await handleResearch(req, res, options, maxBodyBytes, httpRequestId);
        return;
      }
      if (path === "/api/answer") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          jsonError(res, 405, "method not allowed", httpRequestId, req);
          return;
        }
        await handleAnswer(req, res, options, maxBodyBytes, httpRequestId);
        return;
      }
      if (isReadPath(path) && options.readFor !== undefined) {
        await handleReadRoute(req, res, options, path, httpRequestId);
        return;
      }
      if (isMembershipAdminPath(path)) {
        // Not configured (single-tenant host) → indistinguishable from any
        // other unknown path.
        if (options.membershipAdmin === undefined) {
          jsonError(res, 404, "not found", httpRequestId, req);
          return;
        }
        await handleMembershipAdmin({
          req,
          res,
          options,
          handlers: options.membershipAdmin,
          path,
          maxBodyBytes,
          httpRequestId,
        });
        return;
      }
      jsonError(res, 404, "not found", httpRequestId, req);
    })()
      .catch((error: unknown) => {
        failed = true;
        if (!res.headersSent) {
          jsonError(
            res,
            500,
            error instanceof Error ? error.message : "internal error",
            httpRequestId,
            req,
          );
        } else if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      })
      .finally(emit);
  });
}

export function listen(server: Server, host = "127.0.0.1", port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("server did not bind a port"));
    });
  });
}
