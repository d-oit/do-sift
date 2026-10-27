/** HTTP plumbing for the research server: request parsing, body limits, SSE framing, and cancellation binding. */
import { type IncomingMessage, type ServerResponse } from "node:http";
export const MAX_QUESTION = 512;
export const BODY_READ_TIMEOUT_MS = 10_000;
export const READINESS_TIMEOUT_MS = 1_000;
export class HttpRequestError extends Error {
  constructor(
    public readonly status: 400 | 408 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}
export function requestPath(rawUrl: string | undefined): string {
  if (rawUrl === undefined || !rawUrl.startsWith("/")) return "/unmatched";
  const queryStart = rawUrl.indexOf("?");
  const rawPath = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  // Dispatch and receipts use the same fixed route vocabulary, but never
  // canonicalize an alias: //host/... and dot/encoded variants are rejected
  // rather than being allowed to evade an edge rule keyed to the raw target.
  if (rawPath.startsWith("//") || rawPath.includes("#") || rawPath.includes("\\")) {
    return "/unmatched";
  }
  switch (rawPath) {
    case "/":
    case "/index.html":
    case "/healthz":
    case "/readyz":
    case "/metrics":
    case "/api/research":
    case "/api/answer":
      return rawPath;
    default:
      return "/unmatched";
  }
}
export function safeMethod(method: string | undefined): string {
  switch (method) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "POST":
      return method;
    default:
      return "OTHER";
  }
}
export interface ReadinessProbe {
  result: Promise<boolean>;
  settled: Promise<void>;
}
export function startReadinessProbe(probe: () => boolean | Promise<boolean>): ReadinessProbe {
  const underlying = Promise.resolve().then(probe);
  const result = new Promise<boolean>((resolve) => {
    let responseSettled = false;
    const finish = (ready: boolean): void => {
      if (responseSettled) return;
      responseSettled = true;
      clearTimeout(timeout);
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), READINESS_TIMEOUT_MS);
    timeout.unref();
    underlying.then(
      (ready) => finish(Boolean(ready)),
      () => finish(false),
    );
  });
  const settled = underlying.then(
    () => undefined,
    () => undefined,
  );
  return { result, settled };
}
export function jsonError(
  res: ServerResponse,
  status: number,
  message: string,
  requestId: string,
  req?: IncomingMessage,
): void {
  if (req !== undefined) {
    // Error responses can happen before the body has been consumed (auth,
    // media-type, 501, and 413 paths). Close after the response is flushed
    // rather than leaving an attacker-controlled upload attached to keep-alive.
    res.setHeader("connection", "close");
    res.once("finish", () => {
      if (!req.destroyed) req.destroy();
    });
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message, requestId }));
}
export const DEFAULT_REQUEST_DEADLINE_MS = 120_000;
export const SSE_HEARTBEAT_MS = 15_000;
export function respondAuthFailure(
  res: ServerResponse,
  error: unknown,
  requestId: string,
  req: IncomingMessage,
): void {
  if (error instanceof Error && error.name === "AuthError") {
    jsonError(res, 401, error.message, requestId, req);
    return;
  }
  console.error(`[${requestId}] auth failure: ${describeError(error)}`);
  jsonError(res, 500, "internal error", requestId, req);
}
export function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
export function requestHasBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const rawLength = req.headers["content-length"];
  const value = Array.isArray(rawLength) ? rawLength[0] : rawLength;
  return value !== undefined && /^\d+$/u.test(value) && Number(value) > 0;
}
export function rejectBodyOnBodylessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): boolean {
  if (!requestHasBody(req)) return false;
  jsonError(res, 413, "request body is not allowed on this route", requestId, req);
  return true;
}
export function assertJsonContentType(req: IncomingMessage): void {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpRequestError(415, "content-type must be application/json");
  }
}
export function sse(
  res: ServerResponse,
  event: string,
  data: unknown,
  httpRequestId: string,
): void {
  const payload =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), httpRequestId }
      : { httpRequestId, value: data };
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
    const rejectOversize = (): void => {
      // Do not drain an unbounded attacker upload after the 413. The response
      // path closes the request socket after flushing the bounded error.
      req.pause();
      fail(new HttpRequestError(413, "request body exceeds the configured limit"));
    };
    const timeout = setTimeout(() => {
      req.pause();
      fail(new HttpRequestError(408, "request body read timed out"));
    }, BODY_READ_TIMEOUT_MS);
    timeout.unref();
    const declared = req.headers["content-length"];
    const declaredValue = Array.isArray(declared) ? declared[0] : declared;
    if (declaredValue !== undefined && /^\d+$/u.test(declaredValue)) {
      const declaredBytes = Number(declaredValue);
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
        rejectOversize();
        return;
      }
    }
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        rejectOversize();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("aborted", () => fail(new HttpRequestError(400, "request aborted")));
    req.on("error", fail);
  });
}
export async function readQuestion(req: IncomingMessage, maxBytes: number): Promise<string> {
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
  const question = (body as { question?: unknown }).question;
  if (typeof question !== "string") {
    throw new HttpRequestError(400, "question must be a string");
  }
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUESTION) {
    throw new HttpRequestError(400, `question must be 1..${MAX_QUESTION} characters`);
  }
  return trimmed;
}
export interface RequestCancellation {
  signal: AbortSignal;
  cleanup(): void;
  addCleanup(fn: () => void): void;
}
export function bindRequestCancellation(
  req: IncomingMessage,
  res: ServerResponse,
  deadlineMs: number = DEFAULT_REQUEST_DEADLINE_MS,
): RequestCancellation {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  // #62: server-side deadline — a hung provider cannot pin the connection,
  // libSQL handle, or budget reservation indefinitely.
  const deadline = setTimeout(abort, deadlineMs);
  deadline.unref();
  if (req.aborted || res.destroyed) controller.abort();
  const extraCleanup: Array<() => void> = [];
  return {
    signal: controller.signal,
    addCleanup(fn: () => void): void {
      extraCleanup.push(fn);
    },
    cleanup(): void {
      clearTimeout(deadline);
      for (const fn of extraCleanup) fn();
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}
