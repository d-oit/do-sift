import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Repositories,
  applyMigrations,
  backfillPassageEmbeddings,
  backfillPassageNoiseClasses,
  hybridSearch,
  loadMigrations,
  searchByEmbedding,
  searchPassages,
  type PassageNoiseClass,
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

describe("legacy noise-class backfill (SRC-13)", () => {
  /** The classifier is INJECTED (storage cannot depend on a plugin); a
   * keyed stand-in exercises the backfill mechanics — selection, update,
   * idempotence, owner scoping. The real heuristic's behavior is pinned by
   * the harness fixture tests. */
  const classify = (text: string): PassageNoiseClass | undefined => {
    const t = text.trim();
    if ((t.match(/\bList of\b/gu)?.length ?? 0) >= 3) return "nav-list";
    if (/\bRetrieved\s+[A-Z][a-z]+\s+\d{1,2}\b/u.test(t)) return "reference";
    if (t.endsWith(":")) return "stub";
    return undefined;
  };

  it("classifies legacy NULL rows by shape and is idempotent", async () => {
    const docId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://example.test/legacy-backfill",
      originalUrl: "https://example.test/legacy-backfill",
      contentHash: "hash-legacy-backfill-1",
      fetchedAt: "2026-09-15T00:00:00Z",
      rawText: "legacy backfill",
    });
    const nav = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docId,
      excerpt:
        "List of tallest mountains in the Solar System List of mountain peaks by prominence " +
        "List of highest mountains on Earth",
      extractionStatus: "ok",
      // no noiseClass — a pre-SRC-12 legacy row
    });
    const clean = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docId,
      excerpt: "Mount Everest is the highest mountain above sea level, at 8,848 metres.",
      extractionStatus: "ok",
    });
    const updated = await backfillPassageNoiseClasses(client, "owner-a", classify);
    expect(updated).toBe(1); // only the flagged row changes; clean stays NULL
    expect((await repos.passages.get("owner-a", nav))?.noiseClass).toBe("nav-list");
    expect((await repos.passages.get("owner-a", clean))?.noiseClass).toBeUndefined();
    // idempotent: the second pass finds nothing left to classify
    expect(await backfillPassageNoiseClasses(client, "owner-a", classify)).toBe(0);
  });

  it("is owner-scoped — another owner's legacy rows are untouched", async () => {
    await repos.owners.ensure("owner-b", "owner-b");
    const mkDoc = async (owner: string, hash: string) =>
      repos.documents.insert({
        ownerId: owner,
        canonicalUrl: `https://example.test/${hash}`,
        originalUrl: `https://example.test/${hash}`,
        contentHash: hash,
        fetchedAt: "2026-09-15T00:00:00Z",
        rawText: hash,
      });
    const docA = await mkDoc("owner-a", "hash-owner-a-legacy");
    const docB = await mkDoc("owner-b", "hash-owner-b-legacy");
    await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docA,
      excerpt: "Legacy prose for owner a about ranking.",
      extractionStatus: "ok",
    });
    const stubB = await repos.passages.insert({
      ownerId: "owner-b",
      documentId: docB,
      excerpt: "The main tenets of the Peace of Westphalia were:",
      extractionStatus: "ok",
    });
    const updated = await backfillPassageNoiseClasses(client, "owner-a", classify);
    expect(updated).toBe(0); // owner-a's row is clean; owner-b's stub untouched
    expect((await repos.passages.get("owner-b", stubB))?.noiseClass).toBeUndefined();
  });
});
