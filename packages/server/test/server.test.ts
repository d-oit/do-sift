import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import {
  AuthService,
  StaticOidcVerifier,
  type AuthenticatedOwner,
  type VerifiedIdentity,
} from "@do-sift/auth";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import {
  createResearchHarness,
  type ResearchHarnessInstance,
} from "@do-sift/plugin-harness-research";
import { createReadabilityExtractor } from "@do-sift/plugin-extract-readability";
import { BudgetService, Repositories, applyMigrations, loadMigrations } from "@do-sift/storage";
import {
  createResearchServer,
  listen,
  type OperationalEvent,
  type ResearchRunOutcome,
  type ResearchServerOptions,
  type SourceCard,
} from "../src/index.js";

const PAGE_A = [
  "Alpha is the first paragraph of page A and carries the primary claim about the topic at hand.",
  "Beta is the second paragraph of page A with supporting detail and a secondary observation.",
].join("\n\n");

let client: Client;
let server: Server;
let port: number;
let ownerSeen: string | undefined;

const ALICE: VerifiedIdentity = {
  subject: "owner-alice",
  issuer: "https://stub-issuer.test",
  claims: {},
};

async function runResearch(
  ownerId: string,
  question: string,
  onSource: (source: SourceCard) => void,
): Promise<{
  hits: number;
  documentsStored: number;
  passagesStored: number;
  denied: number;
  fetchErrors: number;
  skippedBudget: number;
}> {
  ownerSeen = ownerId;
  const repos = new Repositories(client);
  const search = new FakeSearchProvider({
    hits: [{ url: "https://a.test/page", title: "Page A", snippet: "alpha", rank: 0 }],
  });
  const harness: ResearchHarnessInstance = createResearchHarness(
    { events: { emit: () => {} }, config: {} } as unknown as Parameters<
      typeof createResearchHarness
    >[0],
    {
      search,
      fetchPage: async () => ({ text: PAGE_A, contentType: "text/html" }),
      repositories: repos,
      budget: new BudgetService(client, {
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        maxSearchCalls: 10,
        maxFetches: 10,
      }),
      extract: (text) => createReadabilityExtractorOutput(text),
      onSource,
    },
  );
  await harness.activate({
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 3 },
  } as unknown as Parameters<typeof createResearchHarness>[0]);
  return harness.run({ ownerId, question });
}

// wrap the extractor plugin as a plain function for the harness dep
function createReadabilityExtractorOutput(
  text: string,
): Array<{ text: string; status: "ok" | "partial" }> {
  const extractor = createReadabilityExtractor();
  extractor.activate({
    pluginName: "extract-readability",
    kind: "extractor",
    config: {},
    logger: { info: () => {}, warn: () => {} },
    network: { assertHostAllowed: () => {} },
    secrets: { assertNameAllowed: () => {}, resolve: async () => "" },
    events: { emit: () => {} },
  } as unknown as Parameters<ReturnType<typeof createReadabilityExtractor>["activate"]>[0]);
  return extractor.extract(text);
}

function makeAuth(devBypass: boolean): AuthService {
  return new AuthService(new StaticOidcVerifier({ "token-alice": ALICE }), {
    allowlist: ["owner-alice"],
    devBypass,
    devOwner: "owner-alice",
  });
}

function baseUrl(): string {
  return `http://127.0.0.1:${port}`;
}

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/);
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      if (event === undefined || data === undefined) return null;
      return { event, data: JSON.parse(data) as unknown };
    })
    .filter((e): e is SseEvent => e !== null);
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function rawGetStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

async function rawGetWithBody(port: number, path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "content-length": String(Buffer.byteLength(body)) },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          settled = true;
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(body);
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO owners (id, display_name, created_at) VALUES ('owner-alice', 'Alice', '2026-09-10T00:00:00Z') ON CONFLICT(id) DO NOTHING",
  });
  server = createResearchServer({
    auth: makeAuth(true), // dev bypass ON: loopback requests act as owner-alice
    runResearch,
    answer: async (ownerId, question) => {
      if (question === "boom") throw new Error("model exploded");
      ownerSeen = ownerId;
      return {
        requestId: "req-ans-1",
        answerId: "ans-1",
        cached: false,
        degraded: false,
        evidenceOnly: false,
        blocks: [{ kind: "paragraph", text: "Grounded claim.", citations: ["ev-1"] }],
      };
    },
  });
  port = await listen(server);
});

afterAll(() => {
  server.close();
});

describe("POST /api/research (SSE)", () => {
  it("streams source cards then the run summary, storing evidence", async () => {
    const res = await post("/api/research", { question: "what is alpha?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const httpRequestId = res.headers.get("x-request-id");
    expect(httpRequestId).toMatch(/^[0-9a-f-]{36}$/iu);

    const events = parseSse(await res.text());
    expect(
      events.every(
        (event) => (event.data as { httpRequestId?: unknown }).httpRequestId === httpRequestId,
      ),
    ).toBe(true);
    const sources = events.filter((e) => e.event === "source");
    const done = events.find((e) => e.event === "done");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.data).toMatchObject({
      url: "https://a.test/page",
      title: "Page A",
      passageCount: 2,
    });
    expect(done?.data).toMatchObject({ documentsStored: 1, passagesStored: 2, hits: 1 });
    expect(ownerSeen).toBe("owner-alice"); // dev bypass resolved the allowlisted owner

    // evidence actually stored with provenance
    const repos = new Repositories(client);
    const docs = await repos.documents.list("owner-alice");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.contentHash).toHaveLength(64);
  });

  it("aborts research when the client disconnects", async () => {
    let signalSeen: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const lifecycleServer = createResearchServer({
      auth: makeAuth(true),
      runResearch: (async (
        _ownerId: string,
        _question: string,
        _onSource: (source: SourceCard) => void,
        signal?: AbortSignal,
      ): Promise<ResearchRunOutcome> => {
        signalSeen = signal;
        markStarted();
        return new Promise<ResearchRunOutcome>((_resolve, reject) => {
          const onAbort = (): void => {
            markAborted();
            reject(new DOMException("aborted", "AbortError"));
          };
          if (signal?.aborted === true) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }) as ResearchServerOptions["runResearch"],
    });
    const lifecyclePort = await listen(lifecycleServer);
    const requestController = new AbortController();
    try {
      const responsePromise = fetch(`http://127.0.0.1:${lifecyclePort}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "cancel me" }),
        signal: requestController.signal,
      }).catch(() => undefined);
      await started;
      requestController.abort();
      await aborted;
      const response = await responsePromise;
      if (response !== undefined) await response.arrayBuffer().catch(() => undefined);
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      lifecycleServer.close();
    }
  });

  it("does not start research when the client disconnects during authentication", async () => {
    let markAuthStarted!: () => void;
    const authStarted = new Promise<void>((resolve) => {
      markAuthStarted = resolve;
    });
    let releaseAuth!: () => void;
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    let researchStarted = false;
    const delayedAuthServer = createResearchServer({
      auth: {
        authenticateOwner: async () => {
          markAuthStarted();
          await authGate;
          return { ownerId: "owner-alice", via: "dev-bypass" };
        },
      },
      runResearch: async () => {
        researchStarted = true;
        return {
          hits: 0,
          documentsStored: 0,
          passagesStored: 0,
          denied: 0,
          fetchErrors: 0,
          skippedBudget: 0,
        };
      },
    });
    const delayedPort = await listen(delayedAuthServer);
    const requestController = new AbortController();
    try {
      const responsePromise = fetch(`http://127.0.0.1:${delayedPort}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "cancel during auth" }),
        signal: requestController.signal,
      }).catch(() => undefined);
      await authStarted;
      requestController.abort();
      releaseAuth();
      await responsePromise;
      expect(researchStarted).toBe(false);
    } finally {
      delayedAuthServer.close();
    }
  });

  it("authenticates bearer tokens through the OIDC door", async () => {
    const res = await post(
      "/api/research",
      { question: "q" },
      { authorization: "Bearer token-alice" },
    );
    expect(res.status).toBe(200);
  });

  it("refuses forged tokens (401)", async () => {
    const res = await post("/api/research", { question: "q" }, { authorization: "Bearer forged" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("invalid-token") });
  });

  it("refuses requests when the dev bypass is disabled and no token is present", async () => {
    const locked = createResearchServer({ auth: makeAuth(false), runResearch });
    const lockedPort = await listen(locked);
    try {
      const res = await fetch(`http://127.0.0.1:${lockedPort}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("authentication-required"),
      });
    } finally {
      locked.close();
    }
  });

  it("rejects malformed bodies (400)", async () => {
    expect((await post("/api/research", {})).status).toBe(400);
    expect((await post("/api/research", { question: "" })).status).toBe(400);
    expect((await post("/api/research", { question: "x".repeat(600) })).status).toBe(400);
  });

  it("rejects a non-JSON request content type with 415", async () => {
    const res = await fetch(`${baseUrl()}/api/research`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "question",
    });
    expect(res.status).toBe(415);
  });

  it("returns 413 for an oversized request body", async () => {
    const res = await fetch(`${baseUrl()}/api/research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(9_000) }),
    });
    expect(res.status).toBe(413);
  });

  it("emits a sanitized operational receipt for request failures", async () => {
    const events: OperationalEvent[] = [];
    const eventServer = createResearchServer({
      auth: makeAuth(true),
      runResearch,
      onEvent: (event) => events.push(event),
    } as ResearchServerOptions);
    const eventPort = await listen(eventServer);
    try {
      const res = await fetch(`http://127.0.0.1:${eventPort}/api/research?token=query-secret`, {
        method: "POST",
        headers: { "content-type": "text/plain", authorization: "Bearer token-alice" },
        body: "secret-looking-body",
      });
      expect(res.status).toBe(415);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "http.request",
        method: "POST",
        path: "/api/research",
        status: 415,
        outcome: "client_error",
        requestId: expect.any(String),
      });
      expect(JSON.stringify(events[0])).not.toContain("secret-looking-body");
      expect(JSON.stringify(events[0])).not.toContain("Bearer token-alice");
      expect(JSON.stringify(events[0])).not.toContain("query-secret");

      const health = await fetch(`http://127.0.0.1:${eventPort}/healthz`);
      expect(health.status).toBe(200);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ path: "/healthz", status: 200, outcome: "success" });

      const unknown = await fetch(
        `http://127.0.0.1:${eventPort}/private/path?token=another-secret`,
      );
      expect(unknown.status).toBe(404);
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({ path: "/unmatched", status: 404, outcome: "client_error" });
      expect(JSON.stringify(events[2])).not.toContain("another-secret");

      expect(await rawGetStatus(eventPort, "//host/api/research")).toBe(404);
      expect(events[3]).toMatchObject({ path: "/unmatched", status: 404 });
    } finally {
      eventServer.close();
    }
  });
});

describe("other routes", () => {
  it("serves the source-card page on GET /", async () => {
    const res = await fetch(`${baseUrl()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="question"');
    expect(html).toContain("/api/research");
    expect(html).toContain('id="do-answer"'); // ANS-06: answer mode in the UI
    expect(html).toContain("/api/answer");
    expect(html).toContain('id="answer"');
    // ANS-07: the UI states the evidence basis honestly.
    expect(html).toContain("this question's research run");
    // SRC-25: reused sources are counted honestly in the status line.
    expect(html).toContain(" reused)");
    // SRC-22: the done event's providerHealth receipt is rendered as a
    // status line (per-provider ok/FAILED), cleared on each new submit.
    expect(html).toContain('id="provider-health"');
    expect(html).toContain("data.providerHealth");
    expect(html).toContain("search providers: ");
  });

  it("returns 405 for GET /api/research and 404 elsewhere", async () => {
    expect((await fetch(`${baseUrl()}/api/research`)).status).toBe(405);
    expect((await fetch(`${baseUrl()}/nope`)).status).toBe(404);
  });
});

describe("auth typing sanity", () => {
  it("authenticateOwner returns the allowlisted owner shape", async () => {
    const auth = makeAuth(false);
    const owner: AuthenticatedOwner = await auth.authenticateOwner({ token: "token-alice" });
    expect(owner).toEqual({ ownerId: "owner-alice", via: "oidc" });
  });
});

describe("answer surface (ANS-05)", () => {
  it("answers an authenticated question with the composed payload (200)", async () => {
    ownerSeen = undefined;
    const res = await post("/api/answer", { question: "what is alpha?" });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      requestId?: string;
      answerId: string;
      cached: boolean;
      degraded: boolean;
      evidenceOnly: boolean;
      blocks: Array<{ kind: string; text: string; citations: string[] }>;
    };
    expect(payload).toMatchObject({
      requestId: "req-ans-1",
      answerId: "ans-1",
      cached: false,
      degraded: false,
      evidenceOnly: false,
    });
    expect(payload.blocks[0]?.citations).toEqual(["ev-1"]);
    expect(ownerSeen).toBe("owner-alice"); // auth attribution reached the callback
  });

  it("refuses forged tokens (401) and malformed bodies (400)", async () => {
    expect(
      (await post("/api/answer", { question: "q" }, { authorization: "Bearer forged" })).status,
    ).toBe(401);
    expect((await post("/api/answer", {})).status).toBe(400);
    expect((await post("/api/answer", { question: "" })).status).toBe(400);
    expect((await post("/api/answer", { question: "x".repeat(600) })).status).toBe(400);

    const unsupportedType = await fetch(`${baseUrl()}/api/answer`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "question",
    });
    expect(unsupportedType.status).toBe(415);

    const oversized = await fetch(`${baseUrl()}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(9_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("propagates client disconnect to answer work", async () => {
    let signalSeen: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const answerServer = createResearchServer({
      auth: makeAuth(true),
      runResearch,
      answer: async (_ownerId: string, _question: string, signal?: AbortSignal) => {
        signalSeen = signal;
        markStarted();
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            markAborted();
            reject(new DOMException("aborted", "AbortError"));
          };
          if (signal?.aborted === true) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    });
    const answerPort = await listen(answerServer);
    const requestController = new AbortController();
    try {
      const responsePromise = fetch(`http://127.0.0.1:${answerPort}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "cancel answer" }),
        signal: requestController.signal,
      }).catch(() => undefined);
      await started;
      requestController.abort();
      await aborted;
      const response = await responsePromise;
      if (response !== undefined) await response.arrayBuffer().catch(() => undefined);
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      answerServer.close();
    }
  });

  it("returns 405 for GET /api/answer and 500 when the answer path throws", async () => {
    expect((await fetch(`${baseUrl()}/api/answer`)).status).toBe(405);
    const failed = await post("/api/answer", { question: "boom" });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "model exploded" });
  });

  it("answers 501 when the answer surface is not configured (authed caller informed)", async () => {
    const events: OperationalEvent[] = [];
    const unconfigured = createResearchServer({
      auth: makeAuth(true),
      runResearch,
      onEvent: (event) => events.push(event),
    });
    const unconfiguredPort = await listen(unconfigured);
    try {
      const res = await fetch(`http://127.0.0.1:${unconfiguredPort}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q" }),
      });
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ error: "answer surface not configured" });
      expect(events[0]).toMatchObject({ path: "/api/answer", status: 501, outcome: "unavailable" });
    } finally {
      unconfigured.close();
    }
  });
});

describe("GET /healthz (OPS-05 liveness, unauthenticated)", () => {
  it("answers 200 {ok:true} with no credentials and no data, and is GET-only", async () => {
    const s = createResearchServer({ auth: makeAuth(false), runResearch });
    const p = await listen(s);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // no data leaks: the body is the constant ok object
      expect((await fetch(`http://127.0.0.1:${p}/healthz`, { method: "POST" })).status).toBe(404);
      expect(await rawGetWithBody(p, "/healthz", "unexpected-body")).toBe(413);
    } finally {
      s.close();
    }
  });
});

describe("GET /readyz (OPS-09 readiness)", () => {
  it("distinguishes readiness from liveness without exposing data", async () => {
    const readyOptions = {
      auth: makeAuth(false),
      runResearch,
      readiness: () => true,
    } as ResearchServerOptions;
    const readyServer = createResearchServer(readyOptions);
    const readyPort = await listen(readyServer);
    try {
      const res = await fetch(`http://127.0.0.1:${readyPort}/readyz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await fetch(`http://127.0.0.1:${readyPort}/readyz`, { method: "POST" })).status).toBe(
        404,
      );
    } finally {
      readyServer.close();
    }

    const unavailableOptions = {
      auth: makeAuth(false),
      runResearch,
      readiness: () => false,
    } as ResearchServerOptions;
    const unavailableServer = createResearchServer(unavailableOptions);
    const unavailablePort = await listen(unavailableServer);
    try {
      const res = await fetch(`http://127.0.0.1:${unavailablePort}/readyz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      unavailableServer.close();
    }

    const failingOptions = {
      auth: makeAuth(false),
      runResearch,
      readiness: async () => {
        throw new Error("storage probe failed");
      },
    } as ResearchServerOptions;
    const failingServer = createResearchServer(failingOptions);
    const failingPort = await listen(failingServer);
    try {
      const res = await fetch(`http://127.0.0.1:${failingPort}/readyz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      failingServer.close();
    }
  });

  it("bounds a stalled readiness probe without overlapping retries", async () => {
    let probeCalls = 0;
    const stalledServer = createResearchServer({
      auth: makeAuth(false),
      runResearch,
      readiness: () => {
        probeCalls += 1;
        return new Promise<boolean>(() => {});
      },
    });
    const stalledPort = await listen(stalledServer);
    try {
      const startedAt = Date.now();
      const readiness = await fetch(`http://127.0.0.1:${stalledPort}/readyz`);
      expect(readiness.status).toBe(503);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const secondReadiness = await fetch(`http://127.0.0.1:${stalledPort}/readyz`);
      expect(secondReadiness.status).toBe(503);
      expect(probeCalls).toBe(1);
      const health = await fetch(`http://127.0.0.1:${stalledPort}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      stalledServer.close();
    }
  });
});

describe("source-card relevance prominence (SRC-14)", () => {
  it("forwards relevance receipts on the SSE source event", async () => {
    const cardServer = createResearchServer({
      auth: makeAuth(true),
      runResearch: async (_ownerId, _question, onSource) => {
        onSource({
          url: "https://dopp.test/page",
          title: "Doppelganger",
          passageCount: 3,
          relevanceScore: 0.53,
          relevanceLow: true,
        });
        return {
          hits: 1,
          documentsStored: 1,
          passagesStored: 3,
          denied: 0,
          fetchErrors: 0,
          skippedBudget: 0,
        };
      },
      answer: async () => {
        throw new Error("not used");
      },
    });
    const cardPort = await listen(cardServer);
    try {
      const res = await fetch(`http://127.0.0.1:${cardPort}/api/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q" }),
      });
      const events = parseSse(await res.text());
      const source = events.find((e) => e.event === "source");
      expect(source?.data).toMatchObject({
        url: "https://dopp.test/page",
        relevanceScore: 0.53,
        relevanceLow: true,
      });
    } finally {
      cardServer.close();
    }
  });

  it("the bundled page renders a low-relevance marker on source cards", async () => {
    const res = await fetch(baseUrl());
    const html = await res.text();
    expect(html).toContain("LOW RELEVANCE");
  });
});
