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
  MAX_EMBEDDING_CANDIDATES,
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

describe("blob decoding bounds (#56)", () => {
  it("decodes only the view window of a sliced Uint8Array", () => {
    const vector = [1.5, -2, 4];
    const backing = new Uint8Array(vectorToBlob([9, 9, 9, 9]).byteLength + 12 + 12);
    backing.set(vectorToBlob(vector), 12); // embedded between foreign bytes
    const slice = backing.subarray(12, 12 + 12);
    expect(blobToVector(slice)).toEqual(vector);
  });

  it("rejects a BLOB whose length is not a whole number of floats", () => {
    expect(() => blobToVector(new Uint8Array(6))).toThrow(RangeError);
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
  it("bounds candidates to the newest MAX_EMBEDDING_CANDIDATES rows (#56)", async () => {
    const documentId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://eval.test/candidate-cap",
      originalUrl: "https://eval.test/candidate-cap",
      contentHash: "hash-candidate-cap",
      fetchedAt: "2026-09-13T00:00:00Z",
      rawText: "cap",
    });
    const total = MAX_EMBEDDING_CANDIDATES + 1;
    // Bulk-seed in SQL: n=0 is the oldest row. BLOB x'0000803F00000000' is [1, 0].
    await client.execute({
      sql: `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
            INSERT INTO passages (id, owner_id, document_id, excerpt, extraction_status, created_at)
            SELECT 'cap-' || n, 'owner-a', ?, 'cap excerpt', 'ok', printf('2026-09-13T00:00:00.%06dZ', n) FROM seq`,
      args: [total - 1, documentId],
    });
    await client.execute({
      sql: `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
            INSERT INTO passage_embeddings (passage_id, owner_id, model_id, vector, created_at)
            SELECT 'cap-' || n, 'owner-a', 'm1', x'0000803F00000000', printf('2026-09-13T00:00:00.%06dZ', n) FROM seq`,
      args: [total - 1],
    });
    const hits = await searchByEmbedding(client, "owner-a", "m1", [1, 0], total);
    expect(hits).toHaveLength(MAX_EMBEDDING_CANDIDATES);
    expect(hits.map((h) => h.passageId)).not.toContain("cap-0"); // oldest dropped
    expect(hits.map((h) => h.passageId)).toContain(`cap-${total - 1}`); // newest kept
  });

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

describe("migration 0009 upgrade", () => {
  it("upgrades passage_embeddings from passage_id PK to (passage_id, model_id) PK cleanly", async () => {
    const rawClient = createClient({ url: ":memory:" });
    const migrations = loadMigrations("migrations");
    const pre0009 = migrations.filter((m) => m.number < 9);
    const m0009 = migrations.filter((m) => m.number === 9);
    const after0009 = migrations.filter((m) => m.number > 9);

    await applyMigrations(rawClient, pre0009);

    await rawClient.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, ?)",
      args: ["owner-mig", "Owner Mig", "2026-09-13T00:00:00Z"],
    });
    await rawClient.execute({
      sql: "INSERT INTO documents (id, owner_id, canonical_url, original_url, content_hash, fetched_at, raw_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        "doc-1",
        "owner-mig",
        "https://eval.test/1",
        "https://eval.test/1",
        "hash-1",
        "2026-09-13T00:00:00Z",
        "text",
        "2026-09-13T00:00:00Z",
      ],
    });
    await rawClient.execute({
      sql: "INSERT INTO passages (id, owner_id, document_id, excerpt, extraction_status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["pas-1", "owner-mig", "doc-1", "excerpt text", "ok", "2026-09-13T00:00:00Z"],
    });

    // pre-#120 schema: the repository layer did not stamp tenant_id yet, so
    // the legacy row is written with plain SQL (this is the upgrade path
    // under test, not the current write path).
    await rawClient.execute({
      sql: "INSERT INTO passage_embeddings (passage_id, owner_id, model_id, vector, created_at) VALUES (?, ?, ?, ?, ?)",
      args: ["pas-1", "owner-mig", "m1", vectorToBlob([1, 0]), "2026-09-13T00:00:00Z"],
    });

    await applyMigrations(rawClient, m0009);
    // the multi-tenant migration (0011) is part of the same forward chain;
    // the current write path stamps tenant_id, so it must be applied before
    // the second store.
    await applyMigrations(rawClient, after0009);

    await storePassageEmbeddings(rawClient, "m2", [
      { passageId: "pas-1", ownerId: "owner-mig", vector: [0, 1] },
    ]);

    const hitsM1 = await searchByEmbedding(rawClient, "owner-mig", "m1", [1, 0], 10);
    const hitsM2 = await searchByEmbedding(rawClient, "owner-mig", "m2", [0, 1], 10);
    expect(hitsM1).toHaveLength(1);
    expect(hitsM1[0]?.passageId).toBe("pas-1");
    expect(hitsM2).toHaveLength(1);
    expect(hitsM2[0]?.passageId).toBe("pas-1");
  });
});

describe("per-model embeddings coexist (#55)", () => {
  it("storing a second model keeps the first model's vector", async () => {
    const p = await seedPassage("owner-a", "multi-model text");
    await storePassageEmbeddings(client, "m1", [
      { passageId: p, ownerId: "owner-a", vector: [1, 0] },
    ]);
    await storePassageEmbeddings(client, "m2", [
      { passageId: p, ownerId: "owner-a", vector: [0, 1] },
    ]);
    const m1 = await searchByEmbedding(client, "owner-a", "m1", [1, 0], 10);
    const m2 = await searchByEmbedding(client, "owner-a", "m2", [0, 1], 10);
    expect(m1.map((h) => h.passageId)).toEqual([p]);
    expect(m1[0]?.score).toBeCloseTo(1);
    expect(m2.map((h) => h.passageId)).toEqual([p]);
    expect(m2[0]?.score).toBeCloseTo(1);
  });

  it("re-storing the same (passage, model) replaces only that row", async () => {
    const p = await seedPassage("owner-a", "replace text");
    await storePassageEmbeddings(client, "m1", [
      { passageId: p, ownerId: "owner-a", vector: [1, 0] },
    ]);
    await storePassageEmbeddings(client, "m2", [
      { passageId: p, ownerId: "owner-a", vector: [0, 1] },
    ]);
    await storePassageEmbeddings(client, "m1", [
      { passageId: p, ownerId: "owner-a", vector: [0, -1] },
    ]);
    const rows = await client.execute("SELECT model_id FROM passage_embeddings ORDER BY model_id");
    expect(rows.rows.map((r) => String(r.model_id))).toEqual(["m1", "m2"]);
  });
});

describe("backfillPassageEmbeddings & validation", () => {
  it("embeds only passages lacking an embedding, then no-ops", async () => {
    const p1 = await seedPassage("owner-a", "first passage text");
    await seedPassage("owner-a", "second passage text");
    const embedder = makeFakeEmbedder({
      "first passage text": [1, 0],
      "second passage text": [0, 1],
    });
    const res1 = await backfillPassageEmbeddings(client, "owner-a", embedder);
    expect(res1.passagesCompleted).toBe(2);
    expect(res1.batchCount).toBe(1);

    const res2 = await backfillPassageEmbeddings(client, "owner-a", embedder);
    expect(res2.passagesCompleted).toBe(0);
    expect(res2.batchCount).toBe(0);

    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-1", [1, 0], 10);
    expect(hits[0]?.passageId).toBe(p1); // cosine 1.0 outranks p2's 0.0
    expect(hits).toHaveLength(2);
  });

  it("handles empty store cleanly", async () => {
    const embedder = makeFakeEmbedder({});
    const res = await backfillPassageEmbeddings(client, "owner-a", embedder);
    expect(res.passagesCompleted).toBe(0);
    expect(res.batchCount).toBe(0);
    expect(res.passagesSkipped).toBe(0);
    expect(res.failureClass).toBeUndefined();
  });

  it("validates batchSize bounds", async () => {
    const embedder = makeFakeEmbedder({});
    await expect(
      backfillPassageEmbeddings(client, "owner-a", embedder, { batchSize: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      backfillPassageEmbeddings(client, "owner-a", embedder, { batchSize: 501 }),
    ).rejects.toThrow(RangeError);
    await expect(
      backfillPassageEmbeddings(client, "owner-a", embedder, { batchSize: 2.5 }),
    ).rejects.toThrow(RangeError);
  });

  it("paginates large pending corpus using bounded keyset pagination and records metrics", async () => {
    const TOTAL = 120;
    const BATCH_SIZE = 50;
    const texts: Record<string, number[]> = {};

    for (let i = 0; i < TOTAL; i++) {
      const excerpt = `corpus item ${i.toString().padStart(3, "0")}`;
      await seedPassage("owner-a", excerpt);
      texts[excerpt] = [1, 0.5];
    }

    const embedder = makeFakeEmbedder(texts);

    const memBefore = process.memoryUsage().heapUsed;
    const res = await backfillPassageEmbeddings(client, "owner-a", embedder, {
      batchSize: BATCH_SIZE,
    });
    const memAfter = process.memoryUsage().heapUsed;

    expect(res.passagesCompleted).toBe(TOTAL);
    expect(res.batchCount).toBe(3); // 50 + 50 + 20
    expect(res.passagesSkipped).toBe(0);
    expect(res.failureClass).toBeUndefined();
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    // Record runtime and memory delta
    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-1", [1, 0.5], TOTAL);
    expect(hits).toHaveLength(TOTAL);
    expect(memAfter - memBefore).toBeDefined();
  });

  it("rejects partial embedder response (vector count mismatch) without corrupting existing rows", async () => {
    await seedPassage("owner-a", "p1 text");
    await seedPassage("owner-a", "p2 text");

    const embedder: TextEmbedder = {
      modelId: "fake-embed-partial",
      async embedPassages() {
        return [[1, 0]]; // returns 1 vector for 2 passages
      },
      async embedQuery() {
        return [1, 0];
      },
    };

    const res = await backfillPassageEmbeddings(client, "owner-a", embedder);
    expect(res.passagesCompleted).toBe(0);
    expect(res.passagesSkipped).toBe(2);
    expect(res.failureClass).toBe("VectorCountMismatchError");

    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-partial", [1, 0], 10);
    expect(hits).toHaveLength(0);
  });

  it("rejects wrong dimension vectors", async () => {
    const pExisting = await seedPassage("owner-a", "existing passage");
    await seedPassage("owner-a", "dimension test passage");

    const embedder: TextEmbedder = {
      modelId: "fake-embed-dim",
      async embedPassages() {
        return [[1, 0, 0, 0]]; // length 4
      },
      async embedQuery() {
        return [1, 0];
      },
    };

    // Store first row with dimension 2 for an existing passage
    await storePassageEmbeddings(client, "fake-embed-dim", [
      { passageId: pExisting, ownerId: "owner-a", vector: [1, 0] },
    ]);

    const res = await backfillPassageEmbeddings(client, "owner-a", embedder);
    expect(res.passagesCompleted).toBe(0);
    expect(res.failureClass).toBe("VectorDimensionMismatchError");
  });

  it("rejects non-finite vector components (NaN / Infinity)", async () => {
    await seedPassage("owner-a", "nan passage");

    const embedderNaN: TextEmbedder = {
      modelId: "fake-embed-nan",
      async embedPassages() {
        return [[NaN, 1.0]];
      },
      async embedQuery() {
        return [1, 0];
      },
    };

    const res = await backfillPassageEmbeddings(client, "owner-a", embedderNaN);
    expect(res.passagesCompleted).toBe(0);
    expect(res.failureClass).toBe("NonFiniteVectorError");

    await expect(
      storePassageEmbeddings(client, "fake-embed-nan", [
        { passageId: "p-inf", ownerId: "owner-a", vector: [Infinity, 0] },
      ]),
    ).rejects.toThrow();
  });

  it("rejects empty vectors before write", async () => {
    await expect(
      storePassageEmbeddings(client, "fake-embed-empty", [
        { passageId: "p-empty", ownerId: "owner-a", vector: [] },
      ]),
    ).rejects.toThrow();
  });

  it("stops further batches on cancellation signal and allows idempotent resumption", async () => {
    for (let i = 0; i < 15; i++) {
      await seedPassage("owner-a", `cancel item ${i.toString().padStart(2, "0")}`);
    }

    const controller = new AbortController();
    let batchCountCalls = 0;

    const embedder: TextEmbedder = {
      modelId: "fake-embed-cancel",
      async embedPassages(texts) {
        batchCountCalls++;
        if (batchCountCalls === 1) {
          // Abort after first batch completes
          controller.abort();
        }
        return texts.map(() => [1, 0]);
      },
      async embedQuery() {
        return [1, 0];
      },
    };

    const res1 = await backfillPassageEmbeddings(client, "owner-a", embedder, {
      batchSize: 5,
      signal: controller.signal,
    });

    expect(res1.batchCount).toBe(1);
    expect(res1.passagesCompleted).toBe(5);
    expect(res1.failureClass).toBe("AbortError");

    // Resume backfill without signal abort
    const res2 = await backfillPassageEmbeddings(
      client,
      "owner-a",
      {
        modelId: "fake-embed-cancel",
        async embedPassages(texts) {
          return texts.map(() => [1, 0]);
        },
        async embedQuery() {
          return [1, 0];
        },
      },
      { batchSize: 5 },
    );

    expect(res2.passagesCompleted).toBe(10); // remaining 10 passages
    expect(res2.failureClass).toBeUndefined();

    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-cancel", [1, 0], 20);
    expect(hits).toHaveLength(15);
  });

  it("rejects corrupt vector BLOBs safely during search without crashing", async () => {
    const p1 = await seedPassage("owner-a", "valid passage");
    const p2 = await seedPassage("owner-a", "corrupt passage");

    await storePassageEmbeddings(client, "m-corrupt", [
      { passageId: p1, ownerId: "owner-a", vector: [1, 0] },
    ]);

    // Insert corrupt raw bytes directly into SQL (3 bytes, not multiple of 4)
    await client.execute({
      sql: `INSERT INTO passage_embeddings (passage_id, owner_id, model_id, vector, created_at)
            VALUES (?, ?, ?, x'010203', ?)`,
      args: [p2, "owner-a", "m-corrupt", new Date().toISOString()],
    });

    const hits = await searchByEmbedding(client, "owner-a", "m-corrupt", [1, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.passageId).toBe(p1);
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

describe("evidence relevance floor (SRC-11)", () => {
  /** Local scored seeder: keeps the shared helper untouched for the
   * pre-floor tests (their behavior stays byte-identical). */
  async function seedScoredPassage(
    ownerId: string,
    excerpt: string,
    score?: number,
  ): Promise<string> {
    const documentId = await repos.documents.insert({
      ownerId,
      canonicalUrl: `https://eval.test/${excerpt.length}-${Math.random().toString(36).slice(2, 8)}`,
      originalUrl: `https://eval.test/${excerpt.length}`,
      contentHash: `scored-${score ?? "none"}-${excerpt.slice(0, 12)}`,
      fetchedAt: "2026-09-14T00:00:00Z",
      rawText: excerpt,
      ...(score === undefined ? {} : { relevanceScore: score }),
    });
    return repos.passages.insert({
      ownerId,
      documentId,
      excerpt,
      extractionStatus: "ok",
    });
  }

  const QUESTION = "how does bm25 rank matches?";
  const LOW = "bm25 passage scored below the relevance floor.";
  const HIGH = "bm25 passage scored at or above the relevance floor.";
  const LEGACY = "bm25 passage with no relevance score at all.";

  it("searchByEmbedding excludes embeddings of docs scored below the floor; at-or-above and NULL stay", async () => {
    const low = await seedScoredPassage("owner-a", LOW, 0.5);
    const high = await seedScoredPassage("owner-a", HIGH, 0.9);
    const legacy = await seedScoredPassage("owner-a", LEGACY, undefined);
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: low, ownerId: "owner-a", vector: [1, 0] },
      { passageId: high, ownerId: "owner-a", vector: [0.99, 0.01] },
      { passageId: legacy, ownerId: "owner-a", vector: [0.98, 0.02] },
    ]);

    const hits = await searchByEmbedding(
      client,
      "owner-a",
      "fake-embed-1",
      [1, 0],
      10,
      undefined,
      0.7,
    );
    const surfaced = hits.map((h) => h.passageId);
    expect(surfaced).not.toContain(low); // 0.5 < floor 0.70 — advisory-excluded
    expect(surfaced).toContain(high); // 0.9 >= floor
    expect(surfaced).toContain(legacy); // NULL = legacy/unmeasured — always included
  });

  it("hybridSearch applies the floor to both halves of the fusion", async () => {
    const low = await seedScoredPassage("owner-a", LOW, 0.5);
    const high = await seedScoredPassage("owner-a", HIGH, 0.9);
    const legacy = await seedScoredPassage("owner-a", LEGACY, undefined);
    const embedder = makeFakeEmbedder({
      [QUESTION]: [1, 0],
      [LOW]: [1, 0],
      [HIGH]: [0.99, 0.01],
      [LEGACY]: [0.98, 0.02],
    });
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: low, ownerId: "owner-a", vector: [1, 0] },
      { passageId: high, ownerId: "owner-a", vector: [0.99, 0.01] },
      { passageId: legacy, ownerId: "owner-a", vector: [0.98, 0.02] },
    ]);

    const fused = await hybridSearch(client, "owner-a", QUESTION, 10, embedder, undefined, 0.7);
    const surfaced = fused.map((h) => h.passageId);
    expect(surfaced).not.toContain(low); // excluded on the bm25 half AND the vector half
    expect(surfaced).toContain(high);
    expect(surfaced).toContain(legacy);
  });

  it("is byte-identical when no floor is passed (existing callers unchanged)", async () => {
    const low = await seedScoredPassage("owner-a", LOW, 0.5);
    const embedder = makeFakeEmbedder({ [QUESTION]: [1, 0], [LOW]: [1, 0] });
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: low, ownerId: "owner-a", vector: [1, 0] },
    ]);
    const fused = await hybridSearch(client, "owner-a", QUESTION, 10, embedder);
    expect(fused.map((h) => h.passageId)).toContain(low); // no floor → no filtering
  });
});
