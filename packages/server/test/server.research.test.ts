/** POST /api/research SSE streaming, the remaining routes, and auth typing sanity (ANS-02). */
import { describe, expect, it } from "vitest";
import { type AuthenticatedOwner } from "@do-sift/auth";
import { Repositories } from "@do-sift/storage";
import {
  createResearchServer,
  listen,
  type OperationalEvent,
  type ResearchRunOutcome,
  type ResearchServerOptions,
  type SourceCard,
} from "../src/index.js";
import {
  client,
  ownerSeen,
  runResearch,
  makeAuth,
  baseUrl,
  parseSse,
  post,
  rawGetStatus,
} from "./server-support.js";
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
    expect(owner).toEqual({ ownerId: "owner-alice", tenantId: "default", via: "oidc" });
  });
});
