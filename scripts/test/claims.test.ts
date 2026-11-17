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
});
