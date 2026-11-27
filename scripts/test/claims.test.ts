import { describe, expect, it } from "vitest";
import { assessClaims, summarizeClaims } from "@do-sift/contracts";

const stored = new Set(["ev-1", "ev-2"]);

describe("claim assessment", () => {
  it("separates supported, partial, unresolved, and uncited claims", () => {
    const result = assessClaims(
      [
        { kind: "paragraph", text: "supported", citations: ["ev-1"] },
        { kind: "paragraph", text: "partial", citations: ["ev-1", "ev-missing"] },
        { kind: "paragraph", text: "unresolved", citations: ["ev-missing"] },
        { kind: "caveat", text: "no citation", citations: [] },
      ],
      stored,
    );
    expect(result.map((r) => r.support)).toEqual([
      "supported",
      "partially-supported",
      "unresolved",
      "no-citation",
    ]);
    expect(result[1]?.unresolved).toEqual(["ev-missing"]);
    expect(result[1]?.uncertainty).toBe("partial");
    expect(result[3]?.uncertainty).toBe("unsupported");
  });

  it("does not treat existence as entailment and dedupes citations", () => {
    const [assessment] = assessClaims(
      [{ kind: "paragraph", text: "x", citations: ["ev-1", "ev-1"] }],
      stored,
    );
    expect(assessment?.citations).toEqual(["ev-1"]);
    expect(assessment?.support).toBe("supported");
    // supported only means every cited id exists; no entailment verdict exists
    expect(Object.keys(assessment ?? {})).not.toContain("true");
  });

  it("honours an upstream unresolved flag even when ids resolve", () => {
    const [assessment] = assessClaims(
      [{ kind: "paragraph", text: "x", citations: ["ev-1"], unresolved: true }],
      stored,
    );
    expect(assessment?.support).toBe("partially-supported");
  });

  it("summarizes counts without rounding up", () => {
    const summary = summarizeClaims(
      assessClaims(
        [
          { kind: "paragraph", text: "a", citations: ["ev-1"] },
          { kind: "paragraph", text: "b", citations: ["ev-missing"] },
        ],
        stored,
      ),
    );
    expect(summary).toEqual({
      claims: 2,
      supported: 1,
      partiallySupported: 0,
      unresolved: 1,
      noCitation: 0,
    });
  });

  it("assigns stable claim ids and machine-readable reasons", () => {
    const result = assessClaims(
      [
        { kind: "paragraph", text: "a", citations: ["ev-1"] },
        { kind: "paragraph", text: "b", citations: ["ev-1", "ev-missing"], id: "custom-b" },
        { kind: "caveat", text: "c", citations: [] },
      ],
      stored,
    );
    expect(result.map((r) => r.id)).toEqual(["claim-1", "custom-b", "claim-3"]);
    expect(result.map((r) => r.reason)).toEqual([
      "all-citations-resolve",
      "some-citations-missing",
      "no-citations",
    ]);
  });

  it("echoes producer quotes verbatim and leaves absent quotes absent", () => {
    const result = assessClaims(
      [
        {
          kind: "paragraph",
          text: "a",
          citations: ["ev-1"],
          quote: "ranks keyword matches with bm25",
        },
        { kind: "paragraph", text: "b", citations: ["ev-1"] },
      ],
      stored,
    );
    expect(result[0]?.quote).toBe("ranks keyword matches with bm25");
    expect(result[1]?.quote).toBeUndefined();
    // The receipt carries the quote; nothing validates it yet (plan 070 follow-up).
    expect(result[0]?.support).toBe("supported");
  });

  it("never resolves malformed citation ids", () => {
    const [assessment] = assessClaims(
      [{ kind: "paragraph", text: "x", citations: ["ev-1", "", "   "] }],
      stored,
    );
    expect(assessment?.resolved).toEqual(["ev-1"]);
    expect(assessment?.unresolved).toEqual(["", "   "]);
    expect(assessment?.support).toBe("partially-supported");
    expect(assessment?.reason).toBe("malformed-citations");
  });
});
