/**
 * Stateless report export (FUP-02). The route formats a caller-supplied
 * report with the shared pure formatters; it reads no corpus rows, so these
 * tests use a bare server with a single authenticated owner.
 */
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@do-sift/auth";
import { MAX_COLLECTION_REPORT_ATTACHMENTS } from "@do-sift/contracts";
import { createResearchServer, listen, type ResearchServerOptions } from "../src/index.js";

let server: Server;
let port: number;

const auth: ResearchServerOptions["auth"] = {
  authenticateOwner: async ({ token }) => {
    if (token !== "token-member") throw new AuthError("invalid-token", "no usable token");
    return { ownerId: "member", via: "oidc", tenantId: "acme" };
  },
};

const emptyRun: ResearchServerOptions["runResearch"] = async () => ({
  hits: 0,
  documentsStored: 0,
  passagesStored: 0,
  denied: 0,
  fetchErrors: 0,
  skippedBudget: 0,
});

const REPORT = {
  schemaVersion: 1,
  question: "private research question",
  sources: [
    {
      id: "src-1",
      url: "https://example.test/page",
      title: "<script>alert(1)</script>",
      fetchedAt: "2026-11-01T00:00:00Z",
      publishedAt: "2026-10-01T00:00:00Z",
    },
  ],
  claims: [{ kind: "paragraph", text: "A model-written claim.", citations: ["src-1"] }],
  annotations: [{ id: "note-1", body: "private owner note", createdAt: "2026-11-01T00:00:01Z" }],
};

const storedAnswer = {
  schemaVersion: 1,
  question: "stored answer question",
  sources: [{ id: "psg-1", url: "https://stored.test/a", fetchedAt: "2026-11-01T00:00:00Z" }],
  claims: [
    {
      kind: "paragraph" as const,
      text: "A stored claim with a citation.",
      citations: ["psg-1"],
    },
  ],
  annotations: [],
};

const storedCollection = {
  schemaVersion: 1,
  collection: { title: "Stored collection", description: "Owner context" },
  sources: [{ id: "doc-1", url: "https://collection.test/a", fetchedAt: "2026-11-01T00:00:00Z" }],
  claims: [],
  annotations: [{ id: "note-1", body: "collection note", createdAt: "2026-11-01T00:00:01Z" }],
};

beforeAll(async () => {
  server = createResearchServer({
    auth,
    runResearch: emptyRun,
    reportFor: async () => ({
      fromAnswer: async (_ownerId, id) => (id === "ans-1" ? storedAnswer : undefined),
      fromCollection: async (_ownerId, id) => {
        if (id === "col-1") return storedCollection;
        if (id === "col-large") {
          return {
            ...storedCollection,
            sources: Array.from({ length: MAX_COLLECTION_REPORT_ATTACHMENTS + 1 }, (_, index) => ({
              id: `doc-${index}`,
              url: "https://collection.test/page",
              fetchedAt: "2026-11-01T00:00:00Z",
            })),
          };
        }
        return undefined;
      },
    }),
  });
  port = await listen(server);
});

afterAll(() => {
  server.close();
});

async function post(body: unknown, token: string | undefined = "token-member"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/reports/export`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("report export route (issue #170)", () => {
  it("renders markdown with a download disposition and private fields off by default", async () => {
    const response = await post({ format: "markdown", report: REPORT });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toContain('filename="report.md"');
    const text = await response.text();
    expect(response.headers.get("x-report-sha256")).toBe(
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
    expect(text).toContain("https://example.test/page");
    expect(text).not.toContain("private research question");
    expect(text).not.toContain("private owner note");
  });

  it("carries the exact artifact digest for every format", async () => {
    for (const format of ["json", "markdown", "html", "bibtex"] as const) {
      const response = await post({ format, report: REPORT });
      const text = await response.text();
      expect(response.headers.get("x-report-sha256")).toBe(
        createHash("sha256").update(text, "utf8").digest("hex"),
      );
    }
  });

  it("includes the question and annotations only when explicitly opted in", async () => {
    const response = await post({
      format: "json",
      includeQuestion: true,
      includeAnnotations: true,
      report: REPORT,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      question: string;
      annotations: Array<{ body: string }>;
    };
    expect(body.question).toBe("private research question");
    expect(body.annotations[0]?.body).toBe("private owner note");
  });

  it("escapes source text in the HTML exporter", async () => {
    const response = await post({ format: "html", report: REPORT });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("accepts bounded collection metadata in a caller-supplied report", async () => {
    const response = await post({
      format: "json",
      report: { ...REPORT, collection: { title: "Caller collection", description: "Context" } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      collection: { title: string; description: string };
    };
    expect(body.collection).toEqual({ title: "Caller collection", description: "Context" });

    expect(
      (
        await post({
          format: "json",
          report: { ...REPORT, collection: { title: "x".repeat(201) } },
        })
      ).status,
    ).toBe(400);
    expect((await post({ format: "json", report: { ...REPORT, collection: [] } })).status).toBe(
      400,
    );
  });

  it("rejects unknown formats and reports from a different schema", async () => {
    expect((await post({ format: "pdf", report: REPORT })).status).toBe(400);
    expect((await post({ format: "json", report: { ...REPORT, schemaVersion: 2 } })).status).toBe(
      400,
    );
    expect((await post({ format: "json", report: { schemaVersion: 1 } })).status).toBe(400);
  });

  it("exports claims and citations from a stored answer", async () => {
    const response = await post({ format: "markdown", answerId: "ans-1" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("A stored claim with a citation");
    expect(text).toContain("[psg-1]");
    expect(text).toContain("https://stored.test/a");
    expect(text).not.toContain("stored answer question");
  });

  it("exports a collection report and its notes only when opted in", async () => {
    const response = await post({
      format: "json",
      collectionId: "col-1",
      includeAnnotations: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      collection?: { title: string; description?: string };
      sources: Array<{ url: string }>;
      annotations: Array<{ body: string }>;
    };
    expect(body.collection).toEqual({ title: "Stored collection", description: "Owner context" });
    expect(body.sources[0]?.url).toBe("https://collection.test/a");
    expect(body.annotations[0]?.body).toBe("collection note");
  });

  it("refuses a stored collection above the attachment safety ceiling", async () => {
    const response = await post({ format: "json", collectionId: "col-large" });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("too many attachments");
  });

  it("rejects ambiguous modes and unknown stored ids", async () => {
    expect((await post({ format: "json", report: REPORT, answerId: "ans-1" })).status).toBe(400);
    expect((await post({ format: "json" })).status).toBe(400);
    expect((await post({ format: "json", answerId: "missing" })).status).toBe(404);
    expect((await post({ format: "json", collectionId: "missing" })).status).toBe(404);
  });

  it("answers 501 for stored modes when the host has no reportFor", async () => {
    const bare = createResearchServer({ auth, runResearch: emptyRun });
    const barePort = await listen(bare);
    try {
      const response = await fetch(`http://127.0.0.1:${barePort}/api/reports/export`, {
        method: "POST",
        headers: {
          authorization: "Bearer token-member",
          "content-type": "application/json",
        },
        body: JSON.stringify({ format: "json", answerId: "ans-1" }),
      });
      expect(response.status).toBe(501);
    } finally {
      bare.close();
    }
  });

  it("requires authentication and POST", async () => {
    expect((await post({ format: "json", report: REPORT }, "")).status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${port}/api/reports/export`, {
      headers: { authorization: "Bearer token-member" },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
