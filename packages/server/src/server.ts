/**
 * Research server (SRC-05, plan 003). Host-side HTTP surface on node:http —
 * no framework, no new dependencies. Every request is authenticated through
 * the CORE-04 AuthService (bearer token or loopback-only dev bypass) before
 * it can reach the research pipeline (R-09's seam).
 *
 * POST /api/research → SSE: `source` events as evidence lands, then `done`
 * with the run summary. GET / → the source-card page. Everything else is
 * 404/405. The research runner is injected; this package knows nothing
 * about plugins or storage internals.
 */
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface SourceCard {
  url: string;
  title?: string | undefined;
  passageCount: number;
  /** SRC-14: the raw store-time similarity receipt (undefined without an
   * embedder) — data, not a verdict; see plans/003-004-src-ans.md SRC-14. */
  relevanceScore?: number | undefined;
  /** SRC-14: runtime decoration against the composition's floor — the UI
   * prominence verdict. Receipts are still shown, never hidden. */
  relevanceLow?: boolean | undefined;
}

export interface ResearchRunOutcome {
  hits: number;
  documentsStored: number;
  /** SRC-25: stored URLs reused instead of re-fetched this run. */
  documentsReused?: number | undefined;
  passagesStored: number;
  denied: number;
  fetchErrors: number;
  skippedBudget: number;
  /** SRC-17: per-provider sub-search outcomes (merged compositions only;
   * undefined for single-provider runs) — the health receipt on the SSE
   * done event, making survivor-degradation first-class. */
  providerHealth?: Array<{ provider: string; ok: boolean; error?: string | undefined }> | undefined;
}

export interface ResearchServerOptions {
  /** CORE-04 AuthService-shaped: resolves the owner or throws AuthError. */
  auth: {
    authenticateOwner(request: {
      token?: string | undefined;
      clientAddress?: string | undefined;
    }): Promise<{ ownerId: string; via: string }>;
  };
  /** Runs the zero-LLM pipeline; calls onSource as each source lands. */
  runResearch: (
    ownerId: string,
    question: string,
    onSource: (source: SourceCard) => void,
    signal?: AbortSignal,
  ) => Promise<ResearchRunOutcome>;
  /**
   * Answer surface (ANS-05). When absent, POST /api/answer answers 501 —
   * the route is known but not wired. The payload carries the stored answer
   * blocks (citations resolve to stored evidence) plus the outcome flags;
   * rendering treats block text as data, never markup.
   */
  answer?: ((ownerId: string, question: string) => Promise<AnswerHttpResponse>) | undefined;
  /** Override for tests; defaults to the bundled source-card page. */
  pageHtml?: string;
  /** Request body cap in bytes; default 8192. */
  maxBodyBytes?: number;
}

export interface AnswerHttpResponse {
  requestId?: string | undefined;
  answerId: string;
  /** True on an exact-answer cache hit (nothing re-ran). */
  cached: boolean;
  /** True when the model's citations failed validation. */
  degraded: boolean;
  /** True when no model claims are present (evidence-only output). */
  evidenceOnly: boolean;
  /**
   * Evidence basis (ANS-07, R-15/F9): "run" = evidence came from a
   * completed research run for this question; "cross-question" = the
   * question's own run stored nothing and older corpus evidence was used;
   * "legacy" = pre-linkage evidence. Absent on the empty-evidence path.
   */
  evidenceFromRun?: "run" | "legacy" | "cross-question" | undefined;
  blocks: Array<{
    kind: "paragraph" | "list" | "caveat";
    text: string;
    citations: string[];
  }>;
  usage?:
    | {
        inputTokens: number;
        outputTokens: number;
        model: string;
        estimated: boolean;
      }
    | undefined;
  reconciliation?: { overrun: boolean; deltaInput: number; deltaOutput: number } | undefined;
}

const MAX_QUESTION = 512;

function sse(res: ServerResponse, event: string, data: unknown, httpRequestId: string): void {
  const payload =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), httpRequestId }
      : { httpRequestId, value: data };
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleResearch(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  maxBodyBytes: number,
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  let ownerId: string;
  try {
    const owner = await options.auth.authenticateOwner({
      token,
      clientAddress: req.socket.remoteAddress ?? "",
    });
    ownerId = owner.ownerId;
  } catch (e) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "unauthorized" }));
    return;
  }

  const httpRequestId = randomUUID();
  res.setHeader("x-request-id", httpRequestId);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  const canWrite = (): boolean => !res.destroyed && !res.writableEnded;
  const cleanup = (): void => {
    req.off("aborted", abort);
    res.off("close", abort);
  };

  try {
    let question: string;
    try {
      const body = JSON.parse(await readBody(req, maxBodyBytes)) as { question?: unknown };
      if (typeof body.question !== "string") throw new Error("question must be a string");
      const trimmed = body.question.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_QUESTION) {
        throw new Error(`question must be 1..${MAX_QUESTION} characters`);
      }
      question = trimmed;
    } catch (e) {
      if (controller.signal.aborted) return;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : "bad request" }));
      return;
    }

    if (controller.signal.aborted) return;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    try {
      const outcome = await options.runResearch(
        ownerId,
        question,
        (source) => {
          if (canWrite() && !controller.signal.aborted) sse(res, "source", source, httpRequestId);
        },
        controller.signal,
      );
      if (canWrite() && !controller.signal.aborted) sse(res, "done", outcome, httpRequestId);
    } catch (e) {
      if (canWrite() && !controller.signal.aborted) {
        sse(
          res,
          "error",
          { message: e instanceof Error ? e.message : "research failed" },
          httpRequestId,
        );
      }
    } finally {
      if (canWrite()) res.end();
    }
  } finally {
    cleanup();
  }
}

async function handleAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  maxBodyBytes: number,
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  let ownerId: string;
  try {
    const owner = await options.auth.authenticateOwner({
      token,
      clientAddress: req.socket.remoteAddress ?? "",
    });
    ownerId = owner.ownerId;
  } catch (e) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "unauthorized" }));
    return;
  }

  if (options.answer === undefined) {
    // auth passed first: never reveal surface existence to unauthenticated
    // callers, but do tell an authenticated caller the truth.
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "answer surface not configured" }));
    return;
  }

  let question: string;
  try {
    const body = JSON.parse(await readBody(req, maxBodyBytes)) as { question?: unknown };
    if (typeof body.question !== "string") throw new Error("question must be a string");
    const trimmed = body.question.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_QUESTION) {
      throw new Error(`question must be 1..${MAX_QUESTION} characters`);
    }
    question = trimmed;
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "bad request" }));
    return;
  }

  try {
    const payload = await options.answer(ownerId, question);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "answer failed" }));
  }
}

export function createResearchServer(options: ResearchServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 8192;
  return createHttpServer((req, res) => {
    void (async () => {
      res.setHeader("x-content-type-options", "nosniff");
      const url = req.url ?? "/";
      // Liveness probe (OPS-05): unauthenticated, constant body, no data —
      // safe for any load balancer or container healthcheck. GET-only;
      // other methods fall through to the 404 handler.
      if (req.method === "GET" && url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(options.pageHtml ?? DEFAULT_PAGE);
        return;
      }
      if (url === "/api/research") {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json", allow: "POST" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        await handleResearch(req, res, options, maxBodyBytes);
        return;
      }
      if (url === "/api/answer") {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json", allow: "POST" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        await handleAnswer(req, res, options, maxBodyBytes);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : "internal error" }));
    });
  });
}

/**
 * Listen and resolve the bound port. `port` defaults to 0 (ephemeral, for
 * tests); the app entrypoint passes its configured port.
 */
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

const DEFAULT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>do-sift — research with receipts</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.4rem; } h1 span { color: #6c5ce7; }
  form { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
  input { flex: 1; padding: .6rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  button { padding: .6rem 1.2rem; border: 0; border-radius: 6px; background: #6c5ce7; color: #fff; cursor: pointer; }
  .card { border: 1px solid #e1e1ec; border-radius: 8px; padding: .8rem 1rem; margin-bottom: .75rem; }
  .card a { color: #2d3436; font-weight: 600; text-decoration: none; }
  .card .passages { color: #636e72; font-size: .85rem; }
  .status { color: #636e72; }
</style>
</head>
<body>
<h1>do-sift <span>— research with receipts</span></h1>
<form id="q">
  <input id="question" name="question" placeholder="Ask a question…" autocomplete="off" required>
  <button type="submit" id="do-research">Research</button>
  <button type="submit" id="do-answer">Answer</button>
</form>
<p class="status" id="status"></p>
<p class="status" id="provider-health"></p>
<div id="cards"></div>
<div id="answer"></div>
<script>
  // Fetched text is data, never instructions: only provenance fields and
  // answer block text are rendered, inserted via createTextNode — never
  // innerHTML. Answer block text comes from the model path and is treated
  // exactly like fetched page text.
  document.getElementById("q").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("status");
    const cards = document.getElementById("cards");
    const answerBox = document.getElementById("answer");
    cards.replaceChildren();
    answerBox.replaceChildren();
    // SRC-22: clear the previous run's provider-health receipt up front.
    document.getElementById("provider-health").textContent = "";
    const question = document.getElementById("question").value;
    const mode = e.submitter && e.submitter.id === "do-answer" ? "answer" : "research";
    status.textContent = mode === "answer" ? "Answering…" : "Researching…";
    const res = await fetch(mode === "answer" ? "/api/answer" : "/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (mode === "answer") return renderAnswer(res, status, answerBox);
    return renderResearch(res, status, cards);
  });

  async function renderResearch(res, status, cards) {
    if (!res.ok || !res.body) {
      status.textContent = "Failed: " + (await res.text());
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evLine = chunk.split("\\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\\n").find((l) => l.startsWith("data: "));
        if (!evLine || !dataLine) continue;
        const type = evLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (type === "source") {
          const card = document.createElement("div");
          card.className = "card";
          const link = document.createElement("a");
          link.href = data.url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          link.textContent = data.title || data.url;
          const meta = document.createElement("div");
          meta.className = "passages";
          meta.textContent = data.passageCount + " passage(s) stored as evidence";
          card.append(link, meta);
          // SRC-14: prominence, not removal — a low-relevance source stays
          // visible as a receipt, marked against the evidence floor.
          if (data.relevanceLow === true) {
            const mark = document.createElement("div");
            mark.className = "passages";
            mark.textContent =
              "LOW RELEVANCE — stored as a receipt, excluded from the answer pool";
            card.append(mark);
          }
          cards.append(card);
        } else if (type === "done") {
          // SRC-25: reused sources are shown honestly alongside new stores.
          const reused = data.documentsReused > 0 ? " (" + data.documentsReused + " reused)" : "";
          status.textContent =
            data.documentsStored + " source(s)" + reused + ", " + data.passagesStored + " passage(s).";
          // SRC-17/SRC-22: per-provider sub-search outcomes are receipts,
          // rendered — a degraded provider is visible in the UI, not
          // provenance-only. Provider names and error strings are adapter
          // data: assigned via textContent (never markup).
          const health = document.getElementById("provider-health");
          if (Array.isArray(data.providerHealth) && data.providerHealth.length > 0) {
            health.textContent =
              "search providers: " +
              data.providerHealth
                .map((h) =>
                  h.ok ? h.provider + " ok" : h.provider + " FAILED" + (h.error ? " — " + h.error : ""),
                )
                .join(", ");
          }
        } else if (type === "error") {
          status.textContent = "Research failed: " + data.message;
        }
      }
    }
  }

  async function renderAnswer(res, status, answerBox) {
    if (!res.ok) {
      status.textContent = "Failed: " + (await res.text());
      return;
    }
    const data = await res.json();
    // ANS-07: the evidence basis is stated honestly — an answer drawn from
    // other questions' runs never masquerades as this question's work.
    const basis =
      data.evidenceFromRun === undefined
        ? ""
        : data.evidenceFromRun === "run"
          ? " Evidence fetched by this question's research run."
          : data.evidenceFromRun === "cross-question"
            ? " No stored evidence came from this question's research run — the passages below are from other questions' runs."
            : " Evidence predates run linkage (legacy).";
    const meta = document.createElement("p");
    meta.className = "status";
    meta.textContent =
      (data.cached ? "Served from the exact-answer cache. " : "") +
      (data.evidenceOnly
        ? "Evidence-only output: no model claims (citations failed validation or no evidence)."
        : "Grounded answer — every citation resolved against stored evidence.") +
      basis;
    answerBox.append(meta);
    for (const block of data.blocks) {
      const card = document.createElement("div");
      card.className = "card";
      const kind = document.createElement("div");
      kind.className = "passages";
      kind.textContent = block.kind;
      const text = document.createElement("p");
      text.textContent = block.text;
      const cites = document.createElement("div");
      cites.className = "passages";
      cites.textContent = "cites: " + block.citations.join(", ");
      card.append(kind, text, cites);
      answerBox.append(card);
    }
    status.textContent = data.blocks.length + " answer block(s).";
  }
</script>
</body>
</html>`;
