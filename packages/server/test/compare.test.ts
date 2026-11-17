import { describe, expect, it } from "vitest";
import { ComparisonError, compareEvidence, type ComparisonSourceInput } from "../src/compare.js";

const base = (over: Partial<ComparisonSourceInput> = {}): ComparisonSourceInput => ({
  evidenceId: "ev-1",
  url: "https://a.test/page",
  title: "A",
  retrievedAt: "2026-11-17T00:00:00.000Z",
  excerpt: "The same   excerpt.",
  contentHash: "hash-1",
  ...over,
});

describe("evidence comparison", () => {
  it("orders by the caller's selection and preserves provenance", () => {
    const result = compareEvidence(
      [base(), base({ evidenceId: "ev-2", url: "https://b.test", publishedAt: "2024-01-01" })],
      ["ev-2", "ev-1"],
    );
    expect(result.sources.map((s) => s.evidenceId)).toEqual(["ev-2", "ev-1"]);
    expect(result.sources[0]?.url).toBe("https://b.test");
    expect(result.sources[0]?.retrievedAt).toBe("2026-11-17T00:00:00.000Z");
  });

  it("labels textual agreement without a truth verdict", () => {
    const result = compareEvidence([base(), base({ evidenceId: "ev-2" })]);
    expect(result.observations[0]?.kind).toBe("same-excerpt");
    expect(result.notice).toContain("not reliability or truth signals");
    expect(result.observations.some((o) => o.kind === "same-content-hash")).toBe(true);
  });

  it("reports differences and missing publication dates honestly", () => {
    const result = compareEvidence([
      base(),
      base({ evidenceId: "ev-2", excerpt: "A different excerpt.", contentHash: "hash-2" }),
    ]);
    const kinds = result.observations.map((o) => o.kind);
    expect(kinds).toContain("different-excerpt");
    expect(kinds).toContain("different-content-hash");
    expect(kinds).toContain("missing-publication-date");
    expect(result.sources[1]?.publishedAt).toBeUndefined();
  });

  it("keeps retrieval time separate from publication time", () => {
    const result = compareEvidence([
      base({ publishedAt: "2024-01-01" }),
      base({ evidenceId: "ev-2", publishedAt: "2025-01-01" }),
    ]);
    expect(result.sources[0]?.publishedAt).toBe("2024-01-01");
    expect(result.observations.some((o) => o.kind === "publication-date-mismatch")).toBe(true);
  });

  it("rejects too few, duplicate, unknown, and oversized selections", () => {
    expect(() => compareEvidence([base()])).toThrow(ComparisonError);
    expect(() => compareEvidence([base(), base()])).toThrow(/duplicate/u);
    expect(() => compareEvidence([base(), base({ evidenceId: "ev-2" })], ["ev-1", "nope"])).toThrow(
      /unknown evidence id/u,
    );
    const tooMany = Array.from({ length: 9 }, (_, i) => base({ evidenceId: `ev-${i}` }));
    expect(() => compareEvidence(tooMany)).toThrow(/at most/u);
  });
});
