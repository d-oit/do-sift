/**
 * Runtime composition tests (RET-04, plan 011): one options object wires
 * repositories, budget, research harness (embed-on-store), and the answer
 * service (hybrid retrieval) — the full loop with a synthetic embedder, no
 * real ONNX in tests (the eval covers the real embedder).
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import {
  applyMigrations,
  loadMigrations,
  searchByEmbedding,
  type TextEmbedder,
} from "@do-sift/storage";
import { createRuntime, type Runtime } from "../src/index.js";

const QUESTION = "how does fts5 ranking work?";
const PARAPHRASE = "Saturation effects cap the benefit of repeating words in scored text.";
const KEYWORD_A = "FTS5 ranks keyword matches with bm25, where lower scores are better.";
const KEYWORD_B = "The bm25 function weighs rarer terms more heavily in the ranking.";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO owners (id, display_name, created_at) VALUES ('owner-a', 'Owner A', '2026-09-13T00:00:00Z') ON CONFLICT(id) DO NOTHING",
    args: [],
  });
});

function fakeEmbedder(): TextEmbedder {
  const vectors: Record<string, number[]> = {
    [QUESTION]: [1, 0],
    [KEYWORD_A]: [0.6, 0.4],
    [KEYWORD_B]: [0.55, 0.45],
    [PARAPHRASE]: [0.99, 0.01],
  };
  return {
    modelId: "fake-embed-1",
    async embedPassages(texts) {
      // SRC-11: the harness embeds the WHOLE page (accepted-lead semantics —
      // lead-window similarity by design), and the answer path applies the
      // default exclusion floor (0.70) to the stored receipt. This synthetic
      // embedder pairs unknown body text at 0.95 (≥ the floor) so these
      // composition tests exercise the RET-04 loop (hybrid retrieval over
      // the just-indexed run) rather than the floor's advisory degradation.
      return texts.map((t) => vectors[t] ?? [0.95, 0.31225]);
    },
    async embedQuery(text) {
      return vectors[text] ?? [0, 0, 1];
    },
  };
}

function baseOptions(embedder?: TextEmbedder) {
  const search = new FakeSearchProvider({
    hits: [{ url: "https://a.test/page", title: "Page A", snippet: "fts5", rank: 0 }],
  });
  const pageText = [KEYWORD_A, KEYWORD_B].join("\n\n");
  return {
    client,
    search,
    fetchPage: async () => ({ text: pageText, contentType: "text/html" }),
    model: new FakeModelProvider(),
    budgetCaps: {
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxSearchCalls: 100,
      maxFetches: 100,
    },
    maxFetches: 2,
    ...(embedder === undefined ? {} : { embedder }),
  };
}

describe("createRuntime (RET-04)", () => {
  it("with an embedder: research indexes what it stores, and the answer path retrieves hybrid", async () => {
    const runtime: Runtime = await createRuntime(baseOptions(fakeEmbedder()));

    const summary = await runtime.runResearch("owner-a", QUESTION, (source) => {
      expect(source.url).toBe("https://a.test/page");
      expect(source.passageCount).toBe(2);
    });
    expect(summary.passagesStored).toBe(2);
    expect(summary.embedded).toBe(2);

    // now ask the same question: the answer path runs hybrid retrieval —
    // the packed passages come from the run just indexed (fusion of both
    // lists), provenance intact.
    const outcome = await runtime.answer({ ownerId: "owner-a", question: QUESTION });
    expect(outcome.evidenceOnly).toBe(false);
    expect(outcome.degraded).toBe(false);
    expect(outcome.usage?.model).toBe("fake-model-1");

    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-1", [1, 0], 10);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.excerpt).toBe(KEYWORD_A);
  });

  it("without an embedder: keyword-only behavior on both sides (pre-RET parity)", async () => {
    const runtime = await createRuntime(baseOptions());
    const summary = await runtime.runResearch("owner-a", QUESTION);
    expect(summary.passagesStored).toBe(2);
    expect(summary.embedded).toBeUndefined(); // no embedder configured

    const outcome = await runtime.answer({ ownerId: "owner-a", question: QUESTION });
    expect(outcome.evidenceOnly).toBe(false);
    const hits = await searchByEmbedding(client, "owner-a", "fake-embed-1", [1, 0], 10);
    expect(hits).toHaveLength(0); // nothing was embedded
  });

  it("embeds only new passages on repeated research runs", async () => {
    const runtime = await createRuntime(baseOptions(fakeEmbedder()));
    const first = await runtime.runResearch("owner-a", QUESTION);
    expect(first.embedded).toBe(2);
    // same search hits fetch the same content: cross-RUN store-level dedup
    // is not wired (merge-level URL canonicalization landed in SRC-19), so
    // a second run stores NEW passages (new rows, new ids) and backfills
    // them; existing ones are untouched.
    const second = await runtime.runResearch("owner-a", QUESTION);
    expect(second.passagesStored).toBe(2);
    expect(second.embedded).toBe(2);
  });
});

describe("runtime.answerResponse (ANS-05)", () => {
  it("composes the outcome with the stored blocks; second ask hits the cache", async () => {
    const runtime = await createRuntime(baseOptions(fakeEmbedder()));
    await runtime.runResearch("owner-a", QUESTION);

    const first = await runtime.answerResponse("owner-a", QUESTION);
    expect(first.cached).toBe(false);
    expect(first.evidenceOnly).toBe(false);
    // ANS-07: the research run's evidence is linked and reported as such.
    expect(first.evidenceFromRun).toBe("run");
    expect(first.blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of first.blocks) {
      expect(block.kind).toBe("paragraph");
      expect(block.citations.length).toBeGreaterThan(0); // citations resolve to stored evidence
    }

    const second = await runtime.answerResponse("owner-a", QUESTION);
    expect(second.cached).toBe(true); // exact-answer cache: nothing re-ran
    expect(second.answerId).toBe(first.answerId);
    expect(second.evidenceFromRun).toBe("run"); // basis persisted with the answer
  });
});

describe("runtime without a model (OPS-05: search mode = zero LLM calls)", () => {
  it("research runs with no model configured; the answer surface refuses honestly", async () => {
    const search = new FakeSearchProvider({
      hits: [{ url: "https://a.test/page", title: "Page A", snippet: "fts5", rank: 0 }],
    });
    const runtime = await createRuntime({
      client,
      search,
      fetchPage: async () => ({
        text: [KEYWORD_A, KEYWORD_B].join("\n\n"),
        contentType: "text/html",
      }),
      budgetCaps: {
        maxInputTokens: 10_000,
        maxOutputTokens: 10_000,
        maxSearchCalls: 100,
        maxFetches: 100,
      },
      maxFetches: 2,
      embedder: fakeEmbedder(),
    });

    const summary = await runtime.runResearch("owner-a", QUESTION);
    expect(summary.passagesStored).toBe(2);
    expect(summary.embedded).toBe(2); // embed-on-store is independent of the model

    await expect(runtime.answer({ ownerId: "owner-a", question: QUESTION })).rejects.toThrow(
      /model/,
    );
    await expect(runtime.answerResponse("owner-a", QUESTION)).rejects.toThrow(/model/);
  });
});

describe("source-card relevance prominence (SRC-14)", () => {
  it("the runtime decorates cards with relevanceLow against its floor", async () => {
    // default floor: the synthetic embedder pairs page extracts at 0.95 —
    // NOT low; the raw score receipt is present either way.
    const runtime = await createRuntime(baseOptions(fakeEmbedder()));
    const cards: Array<{
      url: string;
      relevanceScore?: number | undefined;
      relevanceLow?: boolean | undefined;
    }> = [];
    await runtime.runResearch("owner-a", QUESTION, (source) => cards.push(source));
    expect(cards[0]?.relevanceScore).toBeCloseTo(0.95);
    expect(cards[0]?.relevanceLow).toBe(false);

    // a raised floor flips the same receipt to prominence-low — the floor
    // is the runtime's option, applied consistently to cards and answers.
    const strict = await createRuntime({ ...baseOptions(fakeEmbedder()), relevanceFloor: 0.96 });
    const strictCards: Array<{ url: string; relevanceLow?: boolean | undefined }> = [];
    await strict.runResearch("owner-a", QUESTION, (source) => strictCards.push(source));
    expect(strictCards[0]?.relevanceLow).toBe(true);
  });

  it("cards without a score (no embedder) are never marked low", async () => {
    const runtime = await createRuntime(baseOptions());
    const cards: Array<{
      url: string;
      relevanceScore?: number | undefined;
      relevanceLow?: boolean | undefined;
    }> = [];
    await runtime.runResearch("owner-a", QUESTION, (source) => cards.push(source));
    expect(cards[0]?.relevanceScore).toBeUndefined();
    expect(cards[0]?.relevanceLow).toBeUndefined();
  });
});
