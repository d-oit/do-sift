import { createClient, type Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, Repositories } from "../src/index.js";

const MIGRATIONS_DIR = "migrations";

let client: Client;
let repos: Repositories;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations(MIGRATIONS_DIR));
  repos = new Repositories(client);
});

beforeEach(async () => {
  await repos.owners.ensure("owner-a", "Owner A");
  await repos.owners.ensure("owner-b", "Owner B");
});

async function insertDocFor(ownerId: string): Promise<string> {
  return repos.documents.insert({
    ownerId,
    canonicalUrl: "https://example.org/doc",
    originalUrl: "https://example.org/doc?ref=x",
    contentHash: "hash-12345678",
    fetchedAt: "2026-09-07T00:00:00Z",
    title: "Doc",
    rawText: "body text",
  });
}

describe("owners", () => {
  it("ensures idempotently and reads back", async () => {
    await repos.owners.ensure("owner-a", "Renamed A"); // conflict → no-op
    const owner = await repos.owners.get("owner-a");
    expect(owner?.displayName).toBe("Owner A"); // first insert wins
  });
});

describe("documents + passages", () => {
  it("round-trips a document with provenance fields", async () => {
    const id = await insertDocFor("owner-a");
    const doc = await repos.documents.get("owner-a", id);
    expect(doc).toMatchObject({
      canonicalUrl: "https://example.org/doc",
      originalUrl: "https://example.org/doc?ref=x",
      contentHash: "hash-12345678",
      rawText: "body text",
    });
  });

  it("never resolves a document across owners", async () => {
    const id = await insertDocFor("owner-a");
    expect(await repos.documents.get("owner-a", id)).toBeDefined();
    expect(await repos.documents.get("owner-b", id)).toBeUndefined(); // cross-owner negative
    const listB = await repos.documents.list("owner-b");
    expect(listB).toHaveLength(0); // B cannot list A's documents
    const listA = await repos.documents.list("owner-a");
    expect(listA.map((d) => d.id)).toContain(id);
  });

  it("scopes passage listing to the owner", async () => {
    const docA = await insertDocFor("owner-a");
    const passageId = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docA,
      heading: "Section",
      excerpt: "An excerpt of evidence.",
      extractionStatus: "ok",
    });
    expect(await repos.passages.listByDocument("owner-a", docA)).toHaveLength(1);
    expect(await repos.passages.get("owner-b", passageId)).toBeUndefined(); // cross-owner negative
    expect(await repos.passages.listByDocument("owner-b", docA)).toHaveLength(0);
    const passage = await repos.passages.get("owner-a", passageId);
    expect(passage?.extractionStatus).toBe("ok");
  });
});

describe("requests + answers + feedback", () => {
  it("transitions request status and stores answers with cache lookup", async () => {
    const requestId = await repos.requests.create("owner-a", "answer", "What is X?");
    await repos.requests.complete("owner-a", requestId);
    const req = await repos.requests.get("owner-a", requestId);
    expect(req?.status).toBe("completed");

    const answerId = await repos.answers.insert({
      ownerId: "owner-a",
      requestId,
      blocks: [{ kind: "paragraph", text: "claim", citations: [] }],
      evidenceOnly: false,
      cacheKey: "ans:v1:abc123",
      usage: { inputTokens: 100, outputTokens: 20, model: "fake-model-1", estimated: true },
    });
    const answer = await repos.answers.get("owner-a", answerId);
    expect(answer?.usage?.inputTokens).toBe(100);
    expect(answer?.blocks[0]?.text).toBe("claim");
    expect((await repos.answers.findByCacheKey("owner-a", "ans:v1:abc123"))?.id).toBe(answerId);
  });

  it("never shares a cache hit across owners", async () => {
    const requestIdB = await repos.requests.create("owner-b", "answer", "What is X?");
    const answerIdB = await repos.answers.insert({
      ownerId: "owner-b",
      requestId: requestIdB,
      blocks: [],
      evidenceOnly: true,
      cacheKey: "ans:v1:shared-key",
    });
    expect((await repos.answers.findByCacheKey("owner-b", "ans:v1:shared-key"))?.id).toBe(
      answerIdB,
    );
    expect(await repos.answers.findByCacheKey("owner-a", "ans:v1:shared-key")).toBeUndefined(); // cross-owner negative
  });

  it("keeps feedback and request access owner-scoped", async () => {
    const requestId = await repos.requests.create("owner-a", "search", "q");
    const answerId = await repos.answers.insert({
      ownerId: "owner-a",
      requestId,
      blocks: [],
      evidenceOnly: true,
    });
    await repos.feedback.insert("owner-a", answerId, "up", "good");
    expect(await repos.feedback.listByAnswer("owner-a", answerId)).toHaveLength(1);
    expect(await repos.feedback.listByAnswer("owner-b", answerId)).toHaveLength(0); // cross-owner negative
    expect(await repos.requests.get("owner-b", requestId)).toBeUndefined();
  });
});

describe("episodes, jobs, usage ledger", () => {
  it("lists episodes for the owner only", async () => {
    await repos.episodes.insert("owner-a", "question a", "completed", "fine");
    const episodesA = await repos.episodes.list("owner-a");
    const episodesB = await repos.episodes.list("owner-b");
    expect(episodesA.map((e) => e.question)).toContain("question a");
    expect(episodesB).toHaveLength(0); // cross-owner negative
  });

  it("moves a job through statuses, owner-scoped", async () => {
    const jobId = await repos.jobs.insert("owner-a", "fetch", { url: "https://example.org/" });
    const job = await repos.jobs.get("owner-a", jobId);
    expect(job?.status).toBe("queued");
    await repos.jobs.setStatus("owner-a", jobId, "leased", { leaseUntil: "2026-09-07T01:00:00Z" });
    expect((await repos.jobs.get("owner-a", jobId))?.status).toBe("leased");
    await repos.jobs.setStatus("owner-a", jobId, "dead", { lastError: "boom" });
    expect((await repos.jobs.get("owner-a", jobId))?.lastError).toBe("boom");
    expect(await repos.jobs.get("owner-b", jobId)).toBeUndefined(); // cross-owner negative
  });

  it("sums daily usage per owner", async () => {
    await repos.usage.insert({
      ownerId: "owner-a",
      kind: "reservation",
      inputTokens: 1000,
      outputTokens: 200,
      day: "2026-09-07",
      state: "settled",
    });
    await repos.usage.insert({
      ownerId: "owner-a",
      kind: "settlement",
      inputTokens: 500,
      outputTokens: 100,
      day: "2026-09-07",
      state: "settled",
    });
    await repos.usage.insert({
      ownerId: "owner-b",
      kind: "reservation",
      inputTokens: 999,
      outputTokens: 999,
      day: "2026-09-07",
      state: "settled",
    });
    const a = await repos.usage.sumTokensForDay("owner-a", "2026-09-07");
    expect(a).toEqual({ inputTokens: 1500, outputTokens: 300 });
    const b = await repos.usage.sumTokensForDay("owner-b", "2026-09-07");
    expect(b).toEqual({ inputTokens: 999, outputTokens: 999 }); // isolated per owner
  });
});

describe("cross-owner writes (review-security fixtures)", () => {
  it("ignores status mutations addressed with the wrong owner", async () => {
    const requestIdA = await repos.requests.create("owner-a", "answer", "q");
    await repos.requests.complete("owner-b", requestIdA); // wrong owner → no-op
    expect((await repos.requests.get("owner-a", requestIdA))?.status).toBe("pending");

    const jobIdA = await repos.jobs.insert("owner-a", "fetch", {});
    await repos.jobs.setStatus("owner-b", jobIdA, "dead", { lastError: "hijack" });
    expect((await repos.jobs.get("owner-a", jobIdA))?.status).toBe("queued");
    expect((await repos.jobs.get("owner-a", jobIdA))?.lastError).toBeUndefined();
  });

  it("refuses to link records across owners", async () => {
    const docA = await insertDocFor("owner-a");
    await expect(
      repos.passages.insert({
        ownerId: "owner-b",
        documentId: docA,
        excerpt: "smuggled excerpt",
        extractionStatus: "ok",
      }),
    ).rejects.toThrow(/not owned by owner-b/);

    const requestIdA = await repos.requests.create("owner-a", "answer", "q");
    await expect(
      repos.answers.insert({
        ownerId: "owner-b",
        requestId: requestIdA,
        blocks: [],
        evidenceOnly: true,
      }),
    ).rejects.toThrow(/not owned by owner-b/);

    const answerIdA = await repos.answers.insert({
      ownerId: "owner-a",
      requestId: requestIdA,
      blocks: [],
      evidenceOnly: true,
    });
    await expect(repos.feedback.insert("owner-b", answerIdA, "up")).rejects.toThrow(
      /not owned by owner-b/,
    );
  });
});

describe("migration chain over existing data (migrate-storage rule)", () => {
  it("keeps 0001 data alive when 0002 applies", async () => {
    const fresh = createClient({ url: ":memory:" });
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await applyMigrations(fresh, migrations.slice(0, 1)); // 0001 only
    await fresh.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES ('keep-me', 'Old Owner', '2026-09-06T00:00:00Z')",
    });
    await applyMigrations(fresh, migrations); // 0002 lands on top
    const res = await fresh.execute("SELECT display_name FROM owners WHERE id = 'keep-me'");
    expect(res.rows.map((r) => String(r.display_name))).toEqual(["Old Owner"]);
  });
});
