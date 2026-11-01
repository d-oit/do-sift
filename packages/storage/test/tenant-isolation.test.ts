/**
 * Tenant isolation negatives (#120). Attack premise: a principal that is
 * legitimately authenticated in tenant B knows (or guesses) a tenant-A owner
 * id and a tenant-A row id. The owner filter alone would not stop it; the
 * repository's tenant scope must. Every assertion here is fail-closed.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT,
  Repositories,
  TenantScopeError,
  applyMigrations,
  loadMigrations,
  searchPassages,
} from "../src/index.js";

const ACME = "tenant-acme";
const GLOBEX = "tenant-globex";

let client: Client;
let acme: Repositories;
let globex: Repositories;

interface Seeded {
  docId: string;
  passageId: string;
  requestId: string;
  answerId: string;
}

async function seed(repos: Repositories, ownerId: string): Promise<Seeded> {
  const requestId = await repos.requests.create(ownerId, "answer", "how does bm25 rank?");
  const docId = await repos.documents.insert({
    ownerId,
    canonicalUrl: "https://docs.test/bm25",
    originalUrl: "https://docs.test/bm25",
    contentHash: "hash-tenant-0000001",
    fetchedAt: "2026-11-01T00:00:00Z",
    rawText: "bm25 ranking body",
    requestId,
  });
  const passageId = await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt: "bm25 ranks keyword matches and weights rarer terms higher",
    extractionStatus: "ok",
  });
  const answerId = await repos.answers.insert({
    ownerId,
    requestId,
    blocks: [{ kind: "paragraph", text: "bm25 ranks keywords", citations: [passageId] }],
    evidenceOnly: false,
    cacheKey: "cache-tenant-key",
  });
  await repos.feedback.insert(ownerId, answerId, "up", "helpful");
  await repos.episodes.insert(ownerId, "how does bm25 rank?", "completed", "summary");
  return { docId, passageId, requestId, answerId };
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  acme = new Repositories(client, { tenantId: ACME });
  globex = new Repositories(client, { tenantId: GLOBEX });
});

beforeEach(async () => {
  await acme.tenants.ensure(ACME, "Acme Corp");
  await globex.tenants.ensure(GLOBEX, "Globex Inc");
});

describe("tenant-scoped repositories", () => {
  it("defaults to the default tenant and accepts an explicit scope", () => {
    expect(new Repositories(client).tenantId).toBe(DEFAULT_TENANT);
    expect(acme.tenantId).toBe(ACME);
    expect(acme.forTenant(GLOBEX).tenantId).toBe(GLOBEX);
  });

  it("refuses malformed tenant ids before any SQL runs", () => {
    const bad = ["", " ", "tenant a", "a".repeat(129), "-leading", "x'; DROP TABLE owners;--"];
    for (const value of bad) {
      expect(() => new Repositories(client, { tenantId: value }), value).toThrow(TenantScopeError);
    }
    expect(() => new Repositories(client, { tenantId: "tenant/other" })).toThrow(TenantScopeError);
  });

  it("never reads another tenant's rows, even with the exact owner and row ids", async () => {
    await acme.owners.ensure("owner-acme", "Acme Owner");
    const seeded = await seed(acme, "owner-acme");

    expect(await globex.owners.get("owner-acme")).toBeUndefined();
    expect(await globex.documents.get("owner-acme", seeded.docId)).toBeUndefined();
    expect(await globex.documents.list("owner-acme")).toEqual([]);
    expect(
      await globex.documents.findByUrl("owner-acme", "https://docs.test/bm25"),
    ).toBeUndefined();
    expect(await globex.documents.idsByRequestIds("owner-acme", [seeded.requestId])).toEqual([]);
    expect(await globex.documents.linkByDocumentId("owner-acme", [seeded.docId])).toEqual({});
    expect(await globex.passages.get("owner-acme", seeded.passageId)).toBeUndefined();
    expect(await globex.passages.listByDocument("owner-acme", seeded.docId)).toEqual([]);
    expect(await globex.passages.countByDocument("owner-acme", seeded.docId)).toBe(0);
    expect(await globex.requests.get("owner-acme", seeded.requestId)).toBeUndefined();
    expect(await globex.requests.completedSearches("owner-acme")).toEqual([]);
    expect(await globex.answers.get("owner-acme", seeded.answerId)).toBeUndefined();
    expect(await globex.answers.findByCacheKey("owner-acme", "cache-tenant-key")).toBeUndefined();
    expect(await globex.feedback.listByAnswer("owner-acme", seeded.answerId)).toEqual([]);
    expect(await globex.episodes.list("owner-acme")).toEqual([]);

    // the owning tenant still sees everything
    expect((await acme.documents.get("owner-acme", seeded.docId))?.id).toBe(seeded.docId);
    expect((await acme.answers.get("owner-acme", seeded.answerId))?.id).toBe(seeded.answerId);
    expect(await acme.feedback.listByAnswer("owner-acme", seeded.answerId)).toHaveLength(1);
  });

  it("refuses cross-tenant writes that link to another tenant's rows", async () => {
    await acme.owners.ensure("owner-acme", "Acme Owner");
    const seeded = await seed(acme, "owner-acme");
    await globex.owners.ensure("owner-globex", "Globex Owner");

    await expect(
      globex.passages.insert({
        ownerId: "owner-acme",
        documentId: seeded.docId,
        excerpt: "stolen passage",
        extractionStatus: "ok",
      }),
    ).rejects.toThrow(/not owned by/);

    await expect(
      globex.answers.insert({
        ownerId: "owner-acme",
        requestId: seeded.requestId,
        blocks: [{ kind: "paragraph", text: "stolen", citations: [] }],
        evidenceOnly: true,
      }),
    ).rejects.toThrow(/not owned by/);

    await expect(globex.feedback.insert("owner-acme", seeded.answerId, "down")).rejects.toThrow(
      /not owned by/,
    );

    // a foreign tenant's update must be a silent no-op, never a cross-tenant write
    await globex.requests.complete("owner-acme", seeded.requestId);
    expect((await acme.requests.get("owner-acme", seeded.requestId))?.status).toBe("pending");
  });

  it("scopes FTS retrieval to the tenant as well as the owner", async () => {
    await acme.owners.ensure("owner-fts", "Fts Owner");
    await seed(acme, "owner-fts");

    const own = await searchPassages(
      client,
      "owner-fts",
      "bm25 keyword",
      10,
      undefined,
      undefined,
      undefined,
      ACME,
    );
    expect(own.length).toBe(1);
    const other = await searchPassages(
      client,
      "owner-fts",
      "bm25 keyword",
      10,
      undefined,
      undefined,
      undefined,
      GLOBEX,
    );
    expect(other).toEqual([]);
    expect(await searchPassages(client, "owner-fts", "bm25 keyword")).toEqual([]);
    await expect(
      searchPassages(
        client,
        "owner-acme",
        "bm25",
        10,
        undefined,
        undefined,
        undefined,
        "bad tenant",
      ),
    ).rejects.toThrow(TenantScopeError);
  });

  it("registers and reads tenants idempotently", async () => {
    await acme.tenants.ensure(ACME, "Renamed");
    const tenant = await acme.tenants.get(ACME);
    expect(tenant?.displayName).toBe("Acme Corp"); // first insert wins
    expect(await acme.tenants.get("tenant-missing")).toBeUndefined();
    expect(await acme.tenants.get(DEFAULT_TENANT)).toMatchObject({ id: DEFAULT_TENANT });
  });
});
