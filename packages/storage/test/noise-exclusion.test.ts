import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Repositories,
  applyMigrations,
  backfillPassageEmbeddings,
  hybridSearch,
  loadMigrations,
  searchByEmbedding,
  searchPassages,
  type TextEmbedder,
} from "../src/index.js";

/**
 * Noise-class exclusion (SRC-12, store-with-flag): passages flagged at
 * store time with a `noise_class` are excluded from retrieval ONLY when
 * the caller passes the filter — the read-time exclusion mirrors the
 * SRC-11 relevance floor's shape and is byte-identical when omitted, so
 * the versioned retrieval evals and any legacy caller are unaffected.
 */
let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  await repos.owners.ensure("owner-a", "owner-a");
});

/** One document, two passages: a flagged nav-list concatenation and a
 * clean prose passage, both lexically overlapping the test query. */
async function seedMixedPassages(
  ownerId = "owner-a",
): Promise<{ noiseId: string; cleanId: string }> {
  const docId = await repos.documents.insert({
    ownerId,
    canonicalUrl: "https://example.test/mixed",
    originalUrl: "https://example.test/mixed",
    contentHash: "hash-mixed-0001",
    fetchedAt: "2026-09-15T00:00:00Z",
    rawText: "mixed",
  });
  const noiseId = await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt:
      "List of tallest mountains in the Solar System List of mountain peaks by prominence " +
      "List of highest mountains on Earth Summits farthest from the Earth's center",
    extractionStatus: "ok",
    noiseClass: "nav-list",
  });
  const cleanId = await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt:
      "Mount Everest is the highest mountain above sea level, at 8,848 metres, and it is " +
      "not the summit farthest from the Earth's center.",
    extractionStatus: "ok",
  });
  return { noiseId, cleanId };
}

const QUERY = "highest mountain earth elevation";

describe("noise-class exclusion in retrieval (SRC-12)", () => {
  it("searchPassages excludes flagged passages only when the filter is passed", async () => {
    const { noiseId, cleanId } = await seedMixedPassages();
    const filtered = await searchPassages(client, "owner-a", QUERY, 10, undefined, undefined, true);
    expect(filtered.map((h) => h.passageId)).toContain(cleanId);
    expect(filtered.map((h) => h.passageId)).not.toContain(noiseId);
    // byte-identical legacy shape: no filter → both passages surface
    const unfiltered = await searchPassages(client, "owner-a", QUERY, 10);
    expect(unfiltered.map((h) => h.passageId)).toEqual(expect.arrayContaining([noiseId, cleanId]));
  });

  it("searchByEmbedding excludes flagged passages only when the filter is passed", async () => {
    const { noiseId, cleanId } = await seedMixedPassages();
    const embedder: TextEmbedder = {
      modelId: "fake-noise-1",
      async embedPassages(texts) {
        return texts.map((t) => (t.includes("List of") ? [0.9, 0.1] : [0.8, 0.2]));
      },
      async embedQuery() {
        return [1, 0];
      },
    };
    await backfillPassageEmbeddings(client, "owner-a", embedder);
    const filtered = await searchByEmbedding(
      client,
      "owner-a",
      embedder.modelId,
      [1, 0],
      10,
      undefined,
      undefined,
      true,
    );
    expect(filtered.map((h) => h.passageId)).toContain(cleanId);
    expect(filtered.map((h) => h.passageId)).not.toContain(noiseId);
    const unfiltered = await searchByEmbedding(client, "owner-a", embedder.modelId, [1, 0], 10);
    expect(unfiltered.map((h) => h.passageId)).toEqual(expect.arrayContaining([noiseId, cleanId]));
  });

  it("hybridSearch threads the filter through both fusion halves", async () => {
    const { noiseId, cleanId } = await seedMixedPassages();
    const embedder: TextEmbedder = {
      modelId: "fake-noise-1",
      async embedPassages(texts) {
        return texts.map(() => [0.8, 0.2]);
      },
      async embedQuery() {
        return [1, 0];
      },
    };
    await backfillPassageEmbeddings(client, "owner-a", embedder);
    const filtered = await hybridSearch(
      client,
      "owner-a",
      QUERY,
      10,
      embedder,
      undefined,
      undefined,
      true,
    );
    expect(filtered.map((h) => h.passageId)).toContain(cleanId);
    expect(filtered.map((h) => h.passageId)).not.toContain(noiseId);
  });

  it("legacy rows with a NULL noise_class are always included", async () => {
    const docId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://example.test/legacy",
      originalUrl: "https://example.test/legacy",
      contentHash: "hash-legacy-0001",
      fetchedAt: "2026-09-15T00:00:00Z",
      rawText: "legacy",
    });
    await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docId,
      excerpt: "Highest mountain earth legacy passage with plenty of query overlap terms.",
      extractionStatus: "ok",
    });
    const hits = await searchPassages(client, "owner-a", QUERY, 10, undefined, undefined, true);
    expect(hits).toHaveLength(1);
  });
});
