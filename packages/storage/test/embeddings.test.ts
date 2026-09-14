/**
 * Embedding storage + hybrid retrieval tests (RET-02, plan 011). Synthetic
 * vectors only — the fastembed-backed embedder is exercised by the offline
 * eval (evals/datasets/retrieval.json), never in unit tests.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, Repositories, searchPassages } from "@do-sift/storage";
import {
  backfillPassageEmbeddings,
  cosineSimilarity,
  hybridSearch,
  rrfFuse,
  searchByEmbedding,
  storePassageEmbeddings,
  blobToVector,
  vectorToBlob,
  type TextEmbedder,
} from "../src/index.js";

const QUESTION = "how does bm25 rank matches?";

let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  await repos.owners.ensure("owner-a", "Owner A");
  await repos.owners.ensure("owner-b", "Owner B");
});

async function seedPassage(ownerId: string, excerpt: string): Promise<string> {
  const documentId = await repos.documents.insert({
    ownerId,
    canonicalUrl: `https://eval.test/${excerpt.length}-${Math.random().toString(36).slice(2, 8)}`,
    originalUrl: `https://eval.test/${excerpt.length}`,
    contentHash: `hash-${ownerId}-${excerpt.slice(0, 12)}`,
    fetchedAt: "2026-09-13T00:00:00Z",
    rawText: excerpt,
  });
  return repos.passages.insert({
    ownerId,
    documentId,
    excerpt,
    extractionStatus: "ok",
  });
}

/** Fixed-vector fake embedder: vectors keyed by exact text (deterministic). */
function makeFakeEmbedder(vectors: Record<string, number[]>): TextEmbedder {
  return {
    modelId: "fake-embed-1",
    async embedPassages(texts) {
      return texts.map((t) => vectors[t] ?? [0, 0, 1]);
    },
    async embedQuery(text) {
      return vectors[text] ?? [0, 0, 1];
    },
  };
}

describe("blob round-trip", () => {
  it("converts vectors to Float32 bytes and back losslessly", () => {
    const vector = [0.25, -1.5, 3.125, 0];
    const restored = blobToVector(vectorToBlob(vector));
    expect(restored).toEqual(vector);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, negative for opposite", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("store + searchByEmbedding", () => {
  it("ranks by cosine similarity within an owner and model", async () => {
    const pClose = await seedPassage("owner-a", "close passage");
    const pFar = await seedPassage("owner-a", "far passage");
    await storePassageEmbeddings(client, "m1", [
      { passageId: pClose, ownerId: "owner-a", vector: [1, 0] },
      { passageId: pFar, ownerId: "owner-a", vector: [0, 1] },
    ]);
    const hits = await searchByEmbedding(client, "owner-a", "m1", [1, 0], 2);
    expect(hits[0]?.passageId).toBe(pClose);
    expect(hits[0]?.score).toBeCloseTo(1);
    expect(hits).toHaveLength(2);
  });

  it("is owner-scoped: identical vectors for another owner are invisible", async () => {
    const pA = await seedPassage("owner-a", "shared text");
    const pB = await seedPassage("owner-b", "shared text");
    await storePassageEmbeddings(client, "m1", [
      { passageId: pA, ownerId: "owner-a", vector: [1, 0] },
      { passageId: pB, ownerId: "owner-b", vector: [1, 0] },
    ]);
    const hitsA = await searchByEmbedding(client, "owner-a", "m1", [1, 0], 10);
    expect(hitsA.map((h) => h.passageId)).toEqual([pA]);
  });

  it("is model-scoped: another model's embeddings are invisible", async () => {
    const p = await seedPassage("owner-a", "some text");
    await storePassageEmbeddings(client, "m1", [
      { passageId: p, ownerId: "owner-a", vector: [1, 0] },
    ]);
    expect(await searchByEmbedding(client, "owner-a", "m2", [1, 0], 10)).toEqual([]);
  });

  it("honors the limit", async () => {
    const ids = [
      await seedPassage("owner-a", "one"),
      await seedPassage("owner-a", "two"),
      await seedPassage("owner-a", "three"),
    ];
    await storePassageEmbeddings(
      client,
      "m1",
      ids.map((passageId, i) => ({ passageId, ownerId: "owner-a", vector: [1 - i * 0.1, 1] })),
    );
    expect(await searchByEmbedding(client, "owner-a", "m1", [1, 1], 2)).toHaveLength(2);
  });
});

describe("backfillPassageEmbeddings", () => {
  it("embeds only passages lacking an embedding, then no-ops", async () => {
    const p1 = await seedPassage("owner-a", "first passage text");
    await seedPassage("owner-a", "second passage text");
    const embedder = makeFakeEmbedder({
      "first passage text": [1, 0],
      "second passage text": [0, 1],
    });
    expect(await backfillPassageEmbeddings(client, "owner-a", embedder)).toBe(2);
    expect(await backfillPassageEmbeddings(client, "owner-a", embedder)).toBe(0);
    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-1", [1, 0], 10);
    expect(hits[0]?.passageId).toBe(p1); // cosine 1.0 outranks p2's 0.0
    expect(hits).toHaveLength(2);
  });
});

describe("rrfFuse", () => {
  const hit = (passageId: string, score: number) => ({
    passageId,
    documentId: `doc-${passageId}`,
    contentHash: `hash-${passageId}`,
    excerpt: `excerpt ${passageId}`,
    score,
  });

  it("fuses ranks: a passage in both lists outscores single-list passages", () => {
    const bm25 = [hit("a", 1), hit("b", 2), hit("c", 3)];
    const vector = [hit("c", 0.9), hit("d", 0.8)];
    const fused = rrfFuse(bm25, vector, 10);
    // c: 1/61 + 1/61; a: 1/61; b: 1/62; d: 1/62
    expect(fused[0]?.passageId).toBe("c");
    expect(fused.map((h) => h.passageId)).toContain("d");
  });

  it("keeps provenance of vector-only hits and caps the output", () => {
    const bm25 = [hit("a", 1), hit("b", 2)];
    const vector = [hit("d", 0.9), hit("e", 0.8)];
    const fused = rrfFuse(bm25, vector, 3);
    expect(fused).toHaveLength(3);
    const d = fused.find((h) => h.passageId === "d");
    expect(d?.contentHash).toBe("hash-d");
    expect(d?.documentId).toBe("doc-d");
  });
});

describe("hybridSearch", () => {
  it("surfaces a paraphrase passage that pure bm25 misses", async () => {
    const keywordPassage = await seedPassage(
      "owner-a",
      "bm25 ranks keyword matches with term frequency and length normalization.",
    );
    const paraphrasePassage = await seedPassage(
      "owner-a",
      "Saturation effects cap the benefit of repeating words in scored text.",
    );
    const embedder = makeFakeEmbedder({
      [QUESTION]: [1, 0],
      "bm25 ranks keyword matches with term frequency and length normalization.": [0.55, 0.45],
      "Saturation effects cap the benefit of repeating words in scored text.": [0.98, 0.02],
    });
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: keywordPassage, ownerId: "owner-a", vector: [0.55, 0.45] },
      { passageId: paraphrasePassage, ownerId: "owner-a", vector: [0.98, 0.02] },
    ]);

    // bm25 alone: the paraphrase passage shares no query tokens.
    const bm25Only = await searchPassages(client, "owner-a", QUESTION, 5);
    expect(bm25Only.map((h) => h.passageId)).not.toContain(paraphrasePassage);

    // hybrid: the vector list contributes it.
    const fused = await hybridSearch(client, "owner-a", QUESTION, 5, embedder);
    expect(fused.map((h) => h.passageId)).toContain(paraphrasePassage);
    expect(fused[0]?.passageId).toBe(keywordPassage); // in both lists → tops fusion
  });

  it("retrieves through the vector list even for tokenless questions", async () => {
    const p = await seedPassage("owner-a", "bm25 passage about ranking");
    const embedder = makeFakeEmbedder({
      "what is it?": [1, 0],
      "bm25 passage about ranking": [0.9, 0.1],
    });
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: p, ownerId: "owner-a", vector: [0.9, 0.1] },
    ]);
    expect(await searchPassages(client, "owner-a", "what is it?", 5)).toEqual([]); // tokenless
    const fused = await hybridSearch(client, "owner-a", "what is it?", 5, embedder);
    expect(fused.map((h) => h.passageId)).toContain(p);
  });
});
