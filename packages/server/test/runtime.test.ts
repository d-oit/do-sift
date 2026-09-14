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
      return texts.map((t) => vectors[t] ?? [0, 0, 1]);
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
    // same search hits fetch the same content: dedup is not wired (SRC-01
    // canonicalization is later work), so a second run stores NEW passages
    // (new rows, new ids) and backfills them; existing ones are untouched.
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
    expect(first.blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of first.blocks) {
      expect(block.kind).toBe("paragraph");
      expect(block.citations.length).toBeGreaterThan(0); // citations resolve to stored evidence
    }

    const second = await runtime.answerResponse("owner-a", QUESTION);
    expect(second.cached).toBe(true); // exact-answer cache: nothing re-ran
    expect(second.answerId).toBe(first.answerId);
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
