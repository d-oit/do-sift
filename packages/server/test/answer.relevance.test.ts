/** Relevance floor and noise scoping at answer time (ANS-09, SRC-11, SRC-12). */
import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "@do-sift/fake-providers";
import { backfillPassageEmbeddings, type TextEmbedder } from "@do-sift/storage";
import { createAnswerService } from "../src/index.js";
import { QUESTION, client, repos, seedEvidence, makeDeps } from "./answer-support.js";
describe("relevance floor at answer time (SRC-11)", () => {
  /** Own-run documents scored below/above the designed floor: the noise
   * row is lexically overlapping but scored 0.5 — advisory-excluded from
   * the answer pool at the default floor 0.70; the on-topic row (0.9)
   * and the legacy row (NULL) stay. */
  async function seedScoredEvidence(
    ownerId = "owner-a",
  ): Promise<{ noiseId: string; topicId: string }> {
    const ownReq = await repos.requests.create(ownerId, "search", QUESTION);
    const noiseDoc = await repos.documents.insert({
      ownerId,
      canonicalUrl: "https://noise.test/scored",
      originalUrl: "https://noise.test/scored",
      contentHash: "hash-scored-noise-001",
      fetchedAt: "2026-09-14T00:00:00Z",
      rawText: "scored noise",
      requestId: ownReq,
      relevanceScore: 0.5, // below the default floor — lexically overlapping
    });
    const topicDoc = await repos.documents.insert({
      ownerId,
      canonicalUrl: "https://docs.test/scored",
      originalUrl: "https://docs.test/scored",
      contentHash: "hash-scored-topic-001",
      fetchedAt: "2026-09-14T00:00:00Z",
      rawText: "scored topic",
      requestId: ownReq,
      relevanceScore: 0.9,
    });
    await repos.passages.insert({
      ownerId,
      documentId: noiseDoc,
      excerpt: "FTS5 ranks keyword matches with bm25, where lower scores are better.",
      extractionStatus: "ok",
    });
    const topicId = await repos.passages.insert({
      ownerId,
      documentId: topicDoc,
      excerpt: "The bm25 function weighs rarer terms more heavily in the ranking.",
      extractionStatus: "ok",
    });
    await repos.requests.complete(ownerId, ownReq);
    const rows = await client.execute({
      sql: "SELECT id FROM passages WHERE document_id = ?",
      args: [noiseDoc],
    });
    const hit = rows.rows[0];
    if (hit === undefined) throw new Error("noise passage row missing");
    return { noiseId: String(hit.id), topicId };
  }

  it("excludes below-floor documents from the answer pool at the default floor 0.70", async () => {
    const { noiseId, topicId } = await seedScoredEvidence();
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.evidenceFromRun).toBe("run");
    // Only the 0.9-scored row's passage reaches the model; the 0.5 row is
    // advisory-excluded (receipts kept — exclusion is read-time).
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.passageIds).toContain(topicId);
    expect(model.calls[0]?.passageIds).not.toContain(noiseId);
  });

  it("the floor is read-time tunable — a higher option excludes at-or-above rows too", async () => {
    const { noiseId, topicId } = await seedScoredEvidence();
    const modelDefault = new FakeModelProvider();
    const defaultOutcome = await createAnswerService(makeDeps(modelDefault)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    // Default floor 0.70: the 0.5-scored noise row is excluded within the
    // scoped pool; only the 0.9-scored row's passage is packed.
    expect(defaultOutcome.evidenceOnly).toBe(false);
    expect(modelDefault.calls[0]?.passageIds).toContain(topicId);
    expect(modelDefault.calls[0]?.passageIds).not.toContain(noiseId);

    const modelHigh = new FakeModelProvider();
    const highOutcome = await createAnswerService(makeDeps(modelHigh), {
      relevanceFloor: 0.95, // both scored rows exclude → scoped pool empties
    }).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    // The floor emptied the scoped pool → own-run docs are re-included
    // WITHOUT the floor: the floor must not produce empty answers for a
    // question whose own run HAS evidence (the run-006 case-07 remedy).
    expect(highOutcome.evidenceOnly).toBe(false);
    const storedHigh = await repos.answers.get("owner-a", highOutcome.answerId);
    expect(storedHigh?.blocks).toHaveLength(2); // noise + topic re-included
  });
});

describe("relevance-floor scoping (ANS-09)", () => {
  /** Cross-question corpus evidence for the floor boundary: two docs linked
   * to ANOTHER question's completed run (so the asked question has no own
   * run → corpus-fallback retrieval), one scored below the floor, one
   * above. The floor must keep gating here — the scoped-pool fallback
   * exists ONLY for the question's own run's evidence. */
  async function seedCrossQuestionScored(
    ownerId = "owner-a",
  ): Promise<{ belowId: string; aboveId: string }> {
    const otherReq = await repos.requests.create(ownerId, "search", "some other question");
    const belowDoc = await repos.documents.insert({
      ownerId,
      canonicalUrl: "https://cross.test/below",
      originalUrl: "https://cross.test/below",
      contentHash: "hash-cross-below-001",
      fetchedAt: "2026-09-15T00:00:00Z",
      rawText: "cross below",
      requestId: otherReq,
      relevanceScore: 0.5,
    });
    const aboveDoc = await repos.documents.insert({
      ownerId,
      canonicalUrl: "https://cross.test/above",
      originalUrl: "https://cross.test/above",
      contentHash: "hash-cross-above-001",
      fetchedAt: "2026-09-15T00:00:00Z",
      rawText: "cross above",
      requestId: otherReq,
      relevanceScore: 0.9,
    });
    const belowId = await repos.passages.insert({
      ownerId,
      documentId: belowDoc,
      excerpt: "FTS5 ranks keyword matches with bm25, where lower scores are better.",
      extractionStatus: "ok",
    });
    const aboveId = await repos.passages.insert({
      ownerId,
      documentId: aboveDoc,
      excerpt: "The bm25 function weighs rarer terms more heavily in the ranking.",
      extractionStatus: "ok",
    });
    await repos.requests.complete(ownerId, otherReq);
    return { belowId, aboveId };
  }

  it("hybrid path: the floor emptying the scoped pool falls back unfloored too", async () => {
    const reqId = await repos.requests.create("owner-a", "search", QUESTION);
    await seedEvidence("owner-a", reqId, 0.5); // below floor, but own-run
    await repos.requests.complete("owner-a", reqId);
    const excerpt = "FTS5 ranks keyword matches with bm25, where lower scores are better.";
    const vectors: Record<string, number[]> = {
      [QUESTION]: [1, 0],
      [excerpt]: [0.9, 0.1],
    };
    const embedder: TextEmbedder = {
      modelId: "fake-embed-floor",
      async embedPassages(texts) {
        return texts.map((t) => vectors[t] ?? [0, 0, 1]);
      },
      async embedQuery(text) {
        return vectors[text] ?? [0, 0, 1];
      },
    };
    await backfillPassageEmbeddings(client, "owner-a", embedder);
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model, true, embedder)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    // Both fusion halves exclude the only own-run doc at the floor → the
    // scoped hybrid pool empties → the fallback re-runs hybridSearch
    // WITHOUT the floor and the own-run evidence reaches the model.
    expect(outcome.evidenceOnly).toBe(false);
    expect(outcome.evidenceFromRun).toBe("run");
    expect(model.calls[0]?.passageIds.length).toBeGreaterThan(0);
  });

  it("corpus fallback keeps the floor — below-floor cross-question evidence stays excluded", async () => {
    const { belowId, aboveId } = await seedCrossQuestionScored();
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION, // no completed own run → corpus-fallback retrieval
    });
    expect(outcome.evidenceOnly).toBe(false);
    expect(outcome.evidenceFromRun).toBe("cross-question");
    expect(model.calls[0]?.passageIds).toContain(aboveId);
    expect(model.calls[0]?.passageIds).not.toContain(belowId);
  });

  it("corpus fallback never falls back unfloored — an all-below-floor corpus answers empty", async () => {
    const { aboveId } = await seedCrossQuestionScored();
    // remove the above-floor row so every corpus candidate is below floor
    await client.execute({ sql: "DELETE FROM passages WHERE id = ?", args: [aboveId] });
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    // The floor gates cross-question evidence by design (ANS-09): no
    // scoped-pool fallback on the corpus path — the honest empty
    // evidence-only answer, zero model calls.
    expect(outcome.evidenceOnly).toBe(true);
    expect(outcome.degraded).toBe(true);
    expect(outcome.evidenceFromRun).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });
});

describe("noise-flagged passages never reach the answer pool (SRC-12)", () => {
  /** Own-run document carrying one nav-list-flagged chunk and one clean
   * chunk — the run-006 case-06 answer-pool shape. */
  async function seedNoiseAndClean(): Promise<{ noiseId: string; cleanId: string }> {
    const ownReq = await repos.requests.create(
      "owner-a",
      "search",
      "what is the tallest mountain on earth?",
    );
    const doc = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://docs.test/noise-doc",
      originalUrl: "https://docs.test/noise-doc",
      contentHash: "hash-noise-doc-001",
      fetchedAt: "2026-09-15T00:00:00Z",
      rawText: "noise doc",
      requestId: ownReq,
    });
    const noiseId = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: doc,
      excerpt:
        "List of tallest mountains in the Solar System List of mountain peaks by prominence " +
        "List of highest mountains on Earth Summits farthest from the Earth's center",
      extractionStatus: "ok",
      noiseClass: "nav-list",
    });
    const cleanId = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: doc,
      excerpt:
        "Mount Everest is the highest mountain above sea level, at 8,848 metres, and it is " +
        "not the summit farthest from the Earth's center.",
      extractionStatus: "ok",
    });
    await repos.requests.complete("owner-a", ownReq);
    return { noiseId, cleanId };
  }

  it("excludes noise-flagged passages from packing; the store bumps to p2", async () => {
    const { noiseId, cleanId } = await seedNoiseAndClean();
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: "what is the tallest mountain on earth?",
    });
    expect(outcome.evidenceOnly).toBe(false);
    expect(model.calls[0]?.passageIds).toContain(cleanId);
    expect(model.calls[0]?.passageIds).not.toContain(noiseId);
    const stored = await repos.answers.get("owner-a", outcome.answerId);
    expect(stored?.policyRevision).toBe("p4"); // SRC-21: spike-adopted classifier rules (D5; p3 was SRC-18)
  });

  it("noiseFilter:false restores the legacy pool (read-time tunable)", async () => {
    const { noiseId, cleanId } = await seedNoiseAndClean();
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model), { noiseFilter: false }).answer({
      ownerId: "owner-a",
      question: "what is the tallest mountain on earth?",
    });
    expect(outcome.evidenceOnly).toBe(false);
    expect(model.calls[0]?.passageIds).toEqual(expect.arrayContaining([noiseId, cleanId]));
  });
});
