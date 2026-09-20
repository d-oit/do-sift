import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
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
import { createResearchServer, listen, type SourceCard } from "../src/index.js";

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

    const events = parseSse(await res.text());
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
  });

  it("returns 405 for GET /api/answer and 500 when the answer path throws", async () => {
    expect((await fetch(`${baseUrl()}/api/answer`)).status).toBe(405);
    const failed = await post("/api/answer", { question: "boom" });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "model exploded" });
  });

  it("answers 501 when the answer surface is not configured (authed caller informed)", async () => {
    const unconfigured = createResearchServer({ auth: makeAuth(true), runResearch });
    const unconfiguredPort = await listen(unconfigured);
    try {
      const res = await fetch(`http://127.0.0.1:${unconfiguredPort}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q" }),
      });
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ error: "answer surface not configured" });
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
    } finally {
      s.close();
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
