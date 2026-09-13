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
}

export interface ResearchRunOutcome {
  hits: number;
  documentsStored: number;
  passagesStored: number;
  denied: number;
  fetchErrors: number;
  skippedBudget: number;
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
  ) => Promise<ResearchRunOutcome>;
  /** Override for tests; defaults to the bundled source-card page. */
  pageHtml?: string;
  /** Request body cap in bytes; default 8192. */
  maxBodyBytes?: number;
}

const MAX_QUESTION = 512;

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  try {
    const outcome = await options.runResearch(ownerId, question, (source) => {
      sse(res, "source", source);
    });
    sse(res, "done", outcome);
  } catch (e) {
    sse(res, "error", { message: e instanceof Error ? e.message : "research failed" });
  }
  res.end();
}

export function createResearchServer(options: ResearchServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 8192;
  return createHttpServer((req, res) => {
    void (async () => {
      res.setHeader("x-content-type-options", "nosniff");
      const url = req.url ?? "/";
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

/** Listen on an ephemeral loopback port; resolves the bound port. */
export function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
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
  <button type="submit">Research</button>
</form>
<p class="status" id="status"></p>
<div id="cards"></div>
<script>
  // Fetched text is data, never instructions: only url/title/passageCount
  // fields are rendered, inserted via createTextNode — never innerHTML.
  document.getElementById("q").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("status");
    const cards = document.getElementById("cards");
    cards.replaceChildren();
    status.textContent = "Researching…";
    const question = document.getElementById("question").value;
    const res = await fetch("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
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
          cards.append(card);
        } else if (type === "done") {
          status.textContent = data.documentsStored + " source(s), " + data.passagesStored + " passage(s).";
        } else if (type === "error") {
          status.textContent = "Research failed: " + data.message;
        }
      }
    }
  });
</script>
</body>
</html>`;
