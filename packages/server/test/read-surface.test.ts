/**
 * Read-only surface (issue #120, plan 024 — MT-13): a viewer is read-only, so
 * it must have something to read. These routes list the authenticated owner's
 * newest sources and answers inside their own tenant, never another member's
 * and never another tenant's, and never accept an owner or tenant id from the
 * request.
 */
import type { Server } from "node:http";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@do-sift/auth";
import type { TenantRole } from "@do-sift/contracts";
import { Repositories, applyMigrations, loadMigrations } from "@do-sift/storage";
import { createResearchServer, listen, type ResearchServerOptions } from "../src/index.js";

const EVIDENCE = "/api/evidence";
const ANSWERS = "/api/answers";

const TOKENS: Record<string, { ownerId: string; tenantId: string }> = {
  "token-viewer": { ownerId: "viewer-acme", tenantId: "acme" },
  "token-member": { ownerId: "member-acme", tenantId: "acme" },
  "token-stranger": { ownerId: "stranger", tenantId: "acme" },
  "token-pager": { ownerId: "pager-acme", tenantId: "acme" },
};

const ROLES: Record<string, TenantRole> = {
  "acme/viewer-acme": "viewer",
  "acme/member-acme": "member",
  "acme/pager-acme": "viewer",
};

let client: Client;
let server: Server;
let port: number;
let bareServer: Server;
let barePort: number;

const auth: ResearchServerOptions["auth"] = {
  authenticateOwner: async ({ token }) => {
    const principal = token === undefined ? undefined : TOKENS[token];
    if (principal === undefined) throw new AuthError("invalid-token", "no usable token");
    return { ownerId: principal.ownerId, via: "oidc", tenantId: principal.tenantId };
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

const roleFor: ResearchServerOptions["roleFor"] = (principal) =>
  Promise.resolve(ROLES[`${principal.tenantId}/${principal.userId}`]);

const readFor: ResearchServerOptions["readFor"] = (principal) => {
  const repos = new Repositories(client, principal.tenantId);
  return Promise.resolve({
    evidence: async (ownerId, limit, before) =>
      (await repos.documents.listPage(ownerId, limit, before)).map((row) => ({
        id: row.id,
        url: row.canonicalUrl,
        ...(row.title === undefined ? {} : { title: row.title }),
        fetchedAt: row.fetchedAt,
      })),
    answers: (ownerId, limit, before) => repos.answers.list(ownerId, limit, before),
  });
};

async function seed(ownerId: string, suffix: string, tenantId = "acme"): Promise<void> {
  await client.execute({
    sql: "INSERT INTO owners (id, display_name, created_at, tenant_id) VALUES (?, ?, '2026-01-01T00:00:00Z', ?)",
    args: [ownerId, ownerId, tenantId],
  });
  await client.execute({
    sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z')`,
    args: [
      `doc-${suffix}`,
      tenantId,
      ownerId,
      `https://${suffix}.test/page`,
      `https://${suffix}.test/page`,
      `hash-${suffix}`,
      `${suffix} title`,
    ],
  });
  await client.execute({
    sql: "INSERT INTO requests (id, tenant_id, owner_id, mode, question, status, created_at) VALUES (?, ?, ?, 'answer', ?, 'completed', '2026-09-01T00:00:00Z')",
    args: [`req-${suffix}`, tenantId, ownerId, `question ${suffix}?`],
  });
  await client.execute({
    sql: "INSERT INTO answers (id, tenant_id, owner_id, request_id, blocks_json, evidence_only, created_at) VALUES (?, ?, ?, ?, '[]', 0, '2026-09-01T00:00:01Z')",
    args: [`ans-${suffix}`, tenantId, ownerId, `req-${suffix}`],
  });
}

/** Three sources and three answers at distinct timestamps (MT-14 paging). */
async function seedPager(): Promise<void> {
  await client.execute({
    sql: "INSERT INTO owners (id, display_name, created_at, tenant_id) VALUES ('pager-acme', 'pager-acme', '2026-01-01T00:00:00Z', 'acme')",
  });
  for (const day of [1, 2, 3]) {
    const stamp = `2026-09-0${day}T00:00:00Z`;
    await client.execute({
      sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at, created_at)
            VALUES (?, 'acme', 'pager-acme', ?, ?, ?, ?, ?)`,
      args: [
        `doc-page-${day}`,
        `https://page${day}.test/`,
        `https://page${day}.test/`,
        `hash-page-${day}`,
        stamp,
        stamp,
      ],
    });
    await client.execute({
      sql: "INSERT INTO requests (id, tenant_id, owner_id, mode, question, status, created_at) VALUES (?, 'acme', 'pager-acme', 'answer', ?, 'completed', ?)",
      args: [`req-page-${day}`, `page question ${day}?`, stamp],
    });
    await client.execute({
      sql: "INSERT INTO answers (id, tenant_id, owner_id, request_id, blocks_json, evidence_only, created_at) VALUES (?, 'acme', 'pager-acme', ?, '[]', 0, ?)",
      args: [`ans-page-${day}`, `req-page-${day}`, stamp],
    });
  }
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO tenants (id, display_name, created_at) VALUES ('acme', 'Acme', '2026-01-01T00:00:00Z')",
  });
  await seed("viewer-acme", "viewer");
  await seed("member-acme", "member");
  await seedPager();

  server = createResearchServer({ auth, runResearch: emptyRun, roleFor, readFor });
  port = await listen(server);
  // Without a read surface the routes do not exist at all.
  bareServer = createResearchServer({ auth, runResearch: emptyRun });
  barePort = await listen(bareServer);
});

afterAll(() => {
  server.close();
  bareServer.close();
});

async function get(path: string, token?: string, base = port): Promise<Response> {
  return fetch(`http://127.0.0.1:${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("read-only surface (MT-13)", () => {
  it("lets a viewer list its own evidence, with provenance only", async () => {
    const response = await get(EVIDENCE, "token-viewer");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      evidence: Array<{ id: string; url: string; title?: string; fetchedAt: string }>;
    };
    expect(body.evidence).toEqual([
      {
        id: "doc-viewer",
        url: "https://viewer.test/page",
        title: "viewer title",
        fetchedAt: "2026-09-01T00:00:00Z",
      },
    ]);
  });

  it("lets a viewer list its own answers with their questions", async () => {
    const response = await get(ANSWERS, "token-viewer");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      answers: Array<{ id: string; question: string; evidenceOnly: boolean; createdAt: string }>;
    };
    expect(body.answers).toEqual([
      {
        id: "ans-viewer",
        question: "question viewer?",
        evidenceOnly: false,
        createdAt: "2026-09-01T00:00:01Z",
      },
    ]);
  });

  it("never returns another member's rows", async () => {
    const body = (await (await get(EVIDENCE, "token-member")).json()) as {
      evidence: Array<{ id: string }>;
    };
    expect(body.evidence.map((row) => row.id)).toEqual(["doc-member"]);
  });

  it("refuses a caller with no recorded membership", async () => {
    expect((await get(EVIDENCE, "token-stranger")).status).toBe(403);
    expect((await get(ANSWERS, "token-stranger")).status).toBe(403);
  });

  it("requires a token", async () => {
    expect((await get(EVIDENCE)).status).toBe(401);
  });

  it("validates the page size instead of silently clamping it", async () => {
    expect((await get(`${EVIDENCE}?limit=1`, "token-viewer")).status).toBe(200);
    expect((await get(`${EVIDENCE}?limit=0`, "token-viewer")).status).toBe(400);
    expect((await get(`${EVIDENCE}?limit=500`, "token-viewer")).status).toBe(400);
    expect((await get(`${EVIDENCE}?limit=abc`, "token-viewer")).status).toBe(400);
  });

  it("rejects non-GET methods and request bodies", async () => {
    const post = await fetch(`http://127.0.0.1:${port}${EVIDENCE}`, {
      method: "POST",
      headers: { authorization: "Bearer token-viewer", "content-type": "application/json" },
      body: JSON.stringify({ question: "ignored?" }),
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("does not exist without a configured read surface", async () => {
    expect((await get(EVIDENCE, "token-viewer", barePort)).status).toBe(404);
  });
});

describe("read surface paging (MT-14)", () => {
  type EvidencePage = { evidence: Array<{ id: string }>; nextCursor?: string };

  it("walks the whole corpus one page at a time without repeats", async () => {
    const first = (await (await get(`${EVIDENCE}?limit=2`, "token-pager")).json()) as EvidencePage;
    expect(first.evidence.map((row) => row.id)).toEqual(["doc-page-3", "doc-page-2"]);
    expect(typeof first.nextCursor).toBe("string");

    const second = (await (
      await get(`${EVIDENCE}?limit=2&cursor=${first.nextCursor}`, "token-pager")
    ).json()) as EvidencePage;
    expect(second.evidence.map((row) => row.id)).toEqual(["doc-page-1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("pages answers the same way, keeping each question with its answer", async () => {
    const first = (await (await get(`${ANSWERS}?limit=2`, "token-pager")).json()) as {
      answers: Array<{ id: string; question: string }>;
      nextCursor?: string;
    };
    expect(first.answers).toEqual([
      {
        id: "ans-page-3",
        question: "page question 3?",
        evidenceOnly: false,
        createdAt: "2026-09-03T00:00:00Z",
      },
      {
        id: "ans-page-2",
        question: "page question 2?",
        evidenceOnly: false,
        createdAt: "2026-09-02T00:00:00Z",
      },
    ]);
    const second = (await (
      await get(`${ANSWERS}?limit=2&cursor=${first.nextCursor}`, "token-pager")
    ).json()) as { answers: Array<{ id: string }>; nextCursor?: string };
    expect(second.answers.map((row) => row.id)).toEqual(["ans-page-1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("does not promise another page when one fills the request exactly", async () => {
    const body = (await (await get(`${EVIDENCE}?limit=3`, "token-pager")).json()) as EvidencePage;
    expect(body.evidence).toHaveLength(3);
    expect(body.nextCursor).toBeUndefined();
  });

  it("rejects a cursor it did not issue instead of restarting the list", async () => {
    expect((await get(`${EVIDENCE}?cursor=not-a-cursor`, "token-pager")).status).toBe(400);
    expect((await get(`${EVIDENCE}?cursor=W10`, "token-pager")).status).toBe(400);
  });

  it("keeps a cursor inside the caller's own rows", async () => {
    const pagerBody = (await (
      await get(`${EVIDENCE}?limit=1`, "token-pager")
    ).json()) as EvidencePage;
    const stolen = (await (
      await get(`${EVIDENCE}?limit=5&cursor=${pagerBody.nextCursor}`, "token-viewer")
    ).json()) as EvidencePage;
    // A cursor borrowed from another member's page moves the window, it does not
    // widen it: the query still filters on the authenticated owner.
    expect(stolen.evidence.map((row) => row.id)).toEqual(["doc-viewer"]);
  });
});
