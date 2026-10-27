/** Answer surface, liveness, readiness, and source-card relevance prominence (ANS-05, OPS-05, OPS-09, SRC-14). */
import { describe, expect, it } from "vitest";
import {
  createResearchServer,
  listen,
  type OperationalEvent,
  type ResearchServerOptions,
} from "../src/index.js";
import {
  ownerSeen,
  resetOwnerSeen,
  runResearch,
  makeAuth,
  baseUrl,
  parseSse,
  post,
  rawGetWithBody,
} from "./server-support.js";
describe("answer surface (ANS-05)", () => {
  it("answers an authenticated question with the composed payload (200)", async () => {
    resetOwnerSeen();
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

  it("carries the suspect receipt on the payload and emits answer.suspect (ANS-12)", async () => {
    const events: OperationalEvent[] = [];
    const eventServer = createResearchServer({
      auth: makeAuth(true),
      runResearch,
      onEvent: (event) => events.push(event),
      answer: async () => ({
        requestId: "req-ans-2",
        answerId: "ans-2",
        cached: false,
        degraded: false,
        evidenceOnly: false,
        suspectEvidence: { passages: 1, markers: ["role-mimicry"] },
        blocks: [{ kind: "paragraph", text: "Grounded claim.", citations: ["ev-1"] }],
      }),
    } as ResearchServerOptions);
    const eventPort = await listen(eventServer);
    try {
      const res = await fetch(`http://127.0.0.1:${eventPort}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "is this evidence hostile?" }),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        suspectEvidence?: { passages: number; markers: string[] };
      };
      expect(payload.suspectEvidence).toEqual({ passages: 1, markers: ["role-mimicry"] });
      const suspect = events.find((e) => e.type === "answer.suspect");
      expect(suspect).toMatchObject({
        type: "answer.suspect",
        passages: 1,
        markers: ["role-mimicry"],
        requestId: expect.any(String),
      });
      // redaction: receipts carry counts and codes, never question text
      expect(JSON.stringify(suspect)).not.toContain("hostile");
    } finally {
      eventServer.close();
    }
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
    // #61: the internal message never reaches the client
    const body = await failed.json();
    expect(body).toMatchObject({ error: "internal error" });
    expect(JSON.stringify(body)).not.toContain("model exploded");
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
