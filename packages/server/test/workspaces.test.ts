/**
 * Authenticated research-workspace routes (issues #168/#169).
 *
 * Collections are metadata: they reference existing run/evidence ids and are
 * scoped to the principal's tenant and owner. Comparison reads stored
 * passages only. Neither route accepts an owner or tenant from the request.
 */
import type { Server } from "node:http";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@do-sift/auth";
import type { TenantRole } from "@do-sift/contracts";
import {
  CollectionsRepository,
  Repositories,
  applyMigrations,
  loadMigrations,
} from "@do-sift/storage";
import {
  createResearchServer,
  listen,
  type CollectionView,
  type CollectionsHandlers,
  type CompareHandlers,
  type ResearchServerOptions,
} from "../src/index.js";

const TOKENS: Record<string, { ownerId: string; tenantId: string }> = {
  "token-member": { ownerId: "member-acme", tenantId: "acme" },
  "token-other": { ownerId: "other-acme", tenantId: "acme" },
  "token-viewer": { ownerId: "viewer-acme", tenantId: "acme" },
  "token-stranger": { ownerId: "stranger", tenantId: "acme" },
};

const ROLES: Record<string, TenantRole> = {
  "acme/member-acme": "member",
  "acme/other-acme": "member",
  "acme/viewer-acme": "viewer",
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

const roleFor: ResearchServerOptions["roleFor"] = (principal) =>
  Promise.resolve(ROLES[`${principal.tenantId}/${principal.userId}`]);

const emptyRun: ResearchServerOptions["runResearch"] = async () => ({
  hits: 0,
  documentsStored: 0,
  passagesStored: 0,
  denied: 0,
  fetchErrors: 0,
  skippedBudget: 0,
});

/** Mirrors the production wiring: a repository bound to the principal. */
const collectionsFor: ResearchServerOptions["collectionsFor"] = (principal) => {
  const repo = new CollectionsRepository(client, principal.userId, principal.tenantId);
  const handlers: CollectionsHandlers = {
    list: (_ownerId, options) => repo.list(options),
    create: (_ownerId, input) => repo.create(input.title, input.description),
    get: async (_ownerId, id) => {
      const collection = await repo.get(id);
      if (collection === undefined) return undefined;
      const [items, notes] = await Promise.all([repo.items(id), repo.notes(id)]);
      return {
        collection,
        items: items.map((item) => ({
          kind: item.itemKind,
          id: item.itemId,
          addedAt: item.addedAt,
        })),
        notes,
      };
    },
    update: (_ownerId, id, changes) => {
      const next: { title?: string; description?: string } = {};
      if (changes.title !== undefined) next.title = changes.title;
      if (changes.description !== undefined) next.description = changes.description;
      return repo.update(id, next);
    },
    archive: (_ownerId, id) => repo.archive(id),
    addItem: (_ownerId, id, kind, itemId) => repo.addItem(id, kind, itemId),
    removeItem: (_ownerId, id, kind, itemId) => repo.removeItem(id, kind, itemId),
    addNote: (_ownerId, id, body) => repo.addNote(id, body),
    notes: (_ownerId, id) => repo.notes(id),
    deleteNote: (_ownerId, id, noteId) => repo.deleteNote(noteId),
  };
  return Promise.resolve(handlers);
};

const compareFor: ResearchServerOptions["compareFor"] = (principal) => {
  const repos = new Repositories(client, principal.tenantId);
  const handlers: CompareHandlers = {
    sources: (ownerId, ids) => repos.passages.compareSources(ownerId, ids),
  };
  return Promise.resolve(handlers);
};

async function seedOwner(ownerId: string): Promise<void> {
  await client.execute({
    sql: "INSERT INTO owners (id, tenant_id, display_name, created_at) VALUES (?, 'acme', ?, '2026-01-01T00:00:00Z')",
    args: [ownerId, ownerId],
  });
}

async function seedPassage(
  ownerId: string,
  suffix: string,
  publishedAt: string | null,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at, published_at, title, created_at)
          VALUES (?, 'acme', ?, ?, ?, ?, '2026-11-01T00:00:00Z', ?, ?, '2026-11-01T00:00:00Z')`,
    args: [
      `doc-${suffix}`,
      ownerId,
      `https://${suffix}.test/page`,
      `https://${suffix}.test/page`,
      `hash-${suffix}`,
      publishedAt,
      `${suffix} title`,
    ],
  });
  await client.execute({
    sql: `INSERT INTO passages (id, tenant_id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
          VALUES (?, 'acme', ?, ?, 'Heading', ?, 'ok', '2026-11-01T00:00:01Z')`,
    args: [`psg-${suffix}`, ownerId, `doc-${suffix}`, `Excerpt from ${suffix}.`],
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO tenants (id, display_name, created_at) VALUES ('acme', 'Acme', '2026-01-01T00:00:00Z')",
  });
  await seedOwner("member-acme");
  await seedOwner("other-acme");
  await seedOwner("viewer-acme");
  await seedPassage("member-acme", "alpha", "2024-01-01T00:00:00Z");
  await seedPassage("member-acme", "beta", null);

  server = createResearchServer({
    auth,
    runResearch: emptyRun,
    roleFor,
    collectionsFor,
    compareFor,
  });
  port = await listen(server);
  bareServer = createResearchServer({ auth, runResearch: emptyRun });
  barePort = await listen(bareServer);
});

afterAll(() => {
  server.close();
  bareServer.close();
});

async function call(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  base = port,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createCollection(token: string, title: string): Promise<CollectionView> {
  const response = await call("POST", "/api/collections", token, { title });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { collection: CollectionView };
  return body.collection;
}

describe("collections routes (issue #168)", () => {
  it("creates, lists, reads, annotates, and archives an owned collection", async () => {
    const collection = await createCollection("token-member", "Reading list");
    expect(collection.title).toBe("Reading list");

    const list = (await (await call("GET", "/api/collections", "token-member")).json()) as {
      collections: CollectionView[];
    };
    expect(list.collections.map((c) => c.id)).toEqual([collection.id]);

    expect(
      (
        await call("POST", `/api/collections/${collection.id}/items`, "token-member", {
          kind: "evidence",
          id: "psg-alpha",
        })
      ).status,
    ).toBe(204);
    const noteResponse = await call(
      "POST",
      `/api/collections/${collection.id}/notes`,
      "token-member",
      {
        body: "This disagrees with the other source.",
      },
    );
    expect(noteResponse.status).toBe(201);

    const detail = (await (
      await call("GET", `/api/collections/${collection.id}`, "token-member")
    ).json()) as {
      collection: CollectionView;
      items: Array<{ kind: string; id: string }>;
      notes: Array<{ body: string; authorId: string }>;
    };
    expect(detail.items).toEqual([expect.objectContaining({ kind: "evidence", id: "psg-alpha" })]);
    expect(detail.notes[0]).toEqual(
      expect.objectContaining({
        body: "This disagrees with the other source.",
        authorId: "member-acme",
      }),
    );

    expect(
      (
        await call("PATCH", `/api/collections/${collection.id}`, "token-member", {
          title: "Renamed",
        })
      ).status,
    ).toBe(200);
    expect((await call("DELETE", `/api/collections/${collection.id}`, "token-member")).status).toBe(
      200,
    );
    expect((await call("GET", "/api/collections", "token-member")).status).toBe(200);
  });

  it("never exposes another owner's collection", async () => {
    const collection = await createCollection("token-member", "Private");
    const otherList = (await (await call("GET", "/api/collections", "token-other")).json()) as {
      collections: CollectionView[];
    };
    expect(otherList.collections.map((c) => c.id)).not.toContain(collection.id);
    expect((await call("GET", `/api/collections/${collection.id}`, "token-other")).status).toBe(
      404,
    );
    expect(
      (
        await call("PATCH", `/api/collections/${collection.id}`, "token-other", {
          title: "hijack",
        })
      ).status,
    ).toBe(404);
  });

  it("lets a viewer read but not write", async () => {
    expect((await call("GET", "/api/collections", "token-viewer")).status).toBe(200);
    expect((await call("POST", "/api/collections", "token-viewer", { title: "nope" })).status).toBe(
      403,
    );
  });

  it("refuses an unauthenticated caller and a non-member", async () => {
    expect((await call("GET", "/api/collections", undefined)).status).toBe(401);
    expect((await call("GET", "/api/collections", "token-stranger")).status).toBe(403);
  });

  it("validates input and bounds instead of clamping", async () => {
    expect((await call("POST", "/api/collections", "token-member", { title: "" })).status).toBe(
      400,
    );
    expect(
      (
        await call("POST", "/api/collections", "token-member", {
          title: "x".repeat(201),
        })
      ).status,
    ).toBe(400);
    expect((await call("GET", "/api/collections?limit=0", "token-member")).status).toBe(400);
    expect((await call("GET", "/api/collections?limit=500", "token-member")).status).toBe(400);
    expect((await call("POST", "/api/collections", "token-member", [])).status).toBe(400);
    const collection = await createCollection("token-member", "Archive me");
    await call("DELETE", `/api/collections/${collection.id}`, "token-member");
    expect(
      (
        await call("POST", `/api/collections/${collection.id}/items`, "token-member", {
          kind: "run",
          id: "req-1",
        })
      ).status,
    ).toBe(409);
  });

  it("does not exist without a configured surface", async () => {
    expect(
      (await call("GET", "/api/collections", "token-member", undefined, barePort)).status,
    ).toBe(404);
  });
});

describe("comparison route (issue #169)", () => {
  it("compares stored passages with provenance and no truth verdict", async () => {
    const response = await call("POST", "/api/compare", "token-member", {
      ids: ["psg-alpha", "psg-beta"],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      comparison: {
        sources: Array<{ evidenceId: string; publishedAt?: string; retrievedAt: string }>;
        observations: Array<{ kind: string }>;
        notice: string;
      };
    };
    expect(body.comparison.sources.map((s) => s.evidenceId)).toEqual(["psg-alpha", "psg-beta"]);
    expect(body.comparison.sources[0]?.publishedAt).toBe("2024-01-01T00:00:00Z");
    expect(body.comparison.sources[1]?.publishedAt).toBeUndefined();
    expect(body.comparison.observations.some((o) => o.kind === "missing-publication-date")).toBe(
      true,
    );
    expect(body.comparison.notice).toContain("not reliability or truth signals");
  });

  it("rejects unknown, duplicate, too-few, and malformed selections", async () => {
    expect(
      (
        await call("POST", "/api/compare", "token-member", {
          ids: ["psg-alpha", "psg-missing"],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/compare", "token-member", {
          ids: ["psg-alpha", "psg-alpha"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/compare", "token-member", { ids: ["psg-alpha"] })).status,
    ).toBe(400);
    expect((await call("POST", "/api/compare", "token-member", { ids: "nope" })).status).toBe(400);
  });

  it("never reads another owner's passage", async () => {
    expect(
      (
        await call("POST", "/api/compare", "token-other", {
          ids: ["psg-alpha", "psg-beta"],
        })
      ).status,
    ).toBe(404);
  });

  it("only accepts POST and requires authentication", async () => {
    expect((await call("GET", "/api/compare", "token-member")).status).toBe(405);
    expect(
      (await call("POST", "/api/compare", undefined, { ids: ["psg-alpha", "psg-beta"] })).status,
    ).toBe(401);
    // A viewer may compare (read action); the empty result is scope, not role.
    expect(
      (
        await call("POST", "/api/compare", "token-viewer", {
          ids: ["psg-alpha", "psg-beta"],
        })
      ).status,
    ).toBe(404);
  });
});
