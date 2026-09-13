import { describe, expect, it } from "vitest";
import {
  SearchLimits,
  SearchQuery,
  SynthesisRequest,
  estimateTokens,
  validateCitations,
  CitationError,
} from "@do-sift/contracts";
import {
  AbortedError,
  FakeModelProvider,
  FakeSearchProvider,
  makeFakeSearchHit,
} from "../src/index.js";

const searchLimits = SearchLimits.parse({});

describe("FakeSearchProvider", () => {
  it("serves contract-valid hits and respects maxHits", async () => {
    const provider = new FakeSearchProvider({
      hits: [
        { url: "https://a.test/x", title: "A" },
        { url: "https://b.test/y" },
        { url: "https://c.test/z" },
      ],
    });
    const query = SearchQuery.parse({ text: "question", ownerId: "owner-1" });
    const hits = await provider.search(query, SearchLimits.parse({ maxHits: 2 }));
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe("A");
    expect(hits[0]?.provider).toBe("fake-search");
    expect(hits.every((h) => h.rank >= 0)).toBe(true);
    expect(provider.queries).toEqual([query]);
  });

  it("rejects pre-aborted signals and malformed inputs", async () => {
    const provider = new FakeSearchProvider({ hits: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.search(
        SearchQuery.parse({ text: "q", ownerId: "owner-1" }),
        searchLimits,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(AbortedError);
    // The fake re-validates what it is handed (defense in depth).
    await expect(
      provider.search({ text: "", ownerId: "" } as unknown as SearchQuery, searchLimits),
    ).rejects.toThrow();
  });

  it("the SearchLimits contract itself refuses maxHits < 1", () => {
    expect(() => SearchLimits.parse({ maxHits: 0 })).toThrow();
  });

  it("fills defaults so fixtures conform to the SearchHit contract", () => {
    const hit = makeFakeSearchHit({ url: "https://a.test/x" });
    expect(hit.title).toContain("Fixture");
    expect(hit.provider).toBe("fake-search");
    expect(hit.rank).toBe(0);
  });
});

describe("FakeModelProvider", () => {
  const request = SynthesisRequest.parse({
    question: "What is X?",
    passages: [
      { id: "ev-1", text: "X is a thing." },
      { id: "ev-2", text: "X was documented in 2024." },
    ],
    maxInputTokens: 4000,
    maxOutputTokens: 700,
  });

  it("cites only evidence it was given (grounded mode)", async () => {
    const model = new FakeModelProvider();
    const draft = await model.complete(request);
    const cited = draft.blocks.flatMap((b) => b.citations);
    expect(cited).toEqual(["ev-1", "ev-2"]);
    // The pass path of ANS-03: validation against stored evidence succeeds.
    expect(() =>
      validateCitations(
        { ownerId: "o", question: "q", blocks: draft.blocks, evidenceOnly: false },
        new Set(cited),
      ),
    ).not.toThrow();
  });

  it("reports estimated usage over zero", async () => {
    const draft = await new FakeModelProvider().complete(request);
    expect(draft.usage.estimated).toBe(true);
    expect(draft.usage.model).toBe("fake-model-1");
    expect(draft.usage.inputTokens).toBeGreaterThan(0);
    expect(draft.usage.outputTokens).toBe(
      estimateTokens(
        "According to evidence ev-1: X is a thing. According to evidence ev-2: X was documented in 2024.",
      ),
    );
  });

  it("hallucination mode feeds the ANS-03 degradation path", async () => {
    const draft = await new FakeModelProvider({ citationBehavior: "hallucinate" }).complete(
      request,
    );
    const cited = draft.blocks.flatMap((b) => b.citations);
    expect(cited.every((c) => c.startsWith("ev-hallucinated-"))).toBe(true);
    expect(() =>
      validateCitations(
        { ownerId: "o", question: "q", blocks: draft.blocks, evidenceOnly: false },
        new Set(["ev-1", "ev-2"]),
      ),
    ).toThrow(CitationError);
  });

  it("records the bounded call shape (ADR 0006: single call, no tools)", async () => {
    const model = new FakeModelProvider();
    await model.complete(request);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ question: "What is X?", passageIds: ["ev-1", "ev-2"] });
  });

  it("supports the provider-failure path and pre-aborted signals", async () => {
    const failing = new FakeModelProvider({ failWith: new Error("provider down") });
    await expect(failing.complete(request)).rejects.toThrow("provider down");

    const controller = new AbortController();
    controller.abort();
    await expect(
      new FakeModelProvider().complete(request, controller.signal),
    ).rejects.toBeInstanceOf(AbortedError);
    expect(new FakeModelProvider().calls).toHaveLength(0);
  });
});
