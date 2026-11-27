import { describe, expect, it } from "vitest";
import { AnswerBlock } from "../src/evidence.js";
import { DraftAnswer } from "../src/model.js";

describe("producer quote plumbing (issue #160, plan 070)", () => {
  it("accepts an optional verbatim quote on an answer block", () => {
    const block = AnswerBlock.parse({
      kind: "paragraph",
      text: "FTS5 ranks with bm25.",
      citations: ["ev-1"],
      quote: "ranks keyword matches with bm25",
    });
    expect(block.quote).toBe("ranks keyword matches with bm25");
  });

  it("leaves quote absent when the producer supplies none", () => {
    const block = AnswerBlock.parse({
      kind: "paragraph",
      text: "FTS5 ranks with bm25.",
      citations: ["ev-1"],
    });
    expect(block.quote).toBeUndefined();
  });

  it("rejects an empty quote (empty is absent, never a span)", () => {
    expect(() =>
      AnswerBlock.parse({
        kind: "paragraph",
        text: "FTS5 ranks with bm25.",
        citations: ["ev-1"],
        quote: "",
      }),
    ).toThrow();
  });

  it("carries the producer conflict flag on blocks and drafts (plan 072)", () => {
    const block = AnswerBlock.parse({
      kind: "paragraph",
      text: "Sources disagree.",
      citations: ["ev-1", "ev-2"],
      conflicting: true,
    });
    expect(block.conflicting).toBe(true);
    const plain = AnswerBlock.parse({
      kind: "paragraph",
      text: "Agreed.",
      citations: ["ev-1"],
    });
    expect(plain.conflicting).toBeUndefined();
    const draft = DraftAnswer.parse({
      blocks: [
        {
          kind: "paragraph",
          text: "Sources disagree.",
          citations: ["ev-1", "ev-2"],
          conflicting: true,
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, model: "probe", estimated: true },
    });
    expect(draft.blocks[0]?.conflicting).toBe(true);
  });

  it("preserves producer quotes through DraftAnswer.parse instead of stripping them", () => {
    const draft = DraftAnswer.parse({
      blocks: [
        {
          kind: "paragraph",
          text: "FTS5 ranks with bm25.",
          citations: ["ev-1"],
          quote: "ranks keyword matches with bm25",
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, model: "probe", estimated: true },
    });
    expect(draft.blocks[0]?.quote).toBe("ranks keyword matches with bm25");
  });
});
