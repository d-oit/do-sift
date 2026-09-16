/**
 * Merged search composition (SRC-16): unit tests for the pure merge and
 * the composite provider — interleave order, URL dedup, cap, survivor
 * degradation, all-fail typed error, and cancellation propagation.
 */
import { describe, expect, it } from "vitest";
import type { SearchHit, SearchProvider } from "@do-sift/contracts";
import { createMergedSearchProvider, mergeSearchHits, MergedSearchError } from "../src/index.js";

function hit(provider: string, url: string, rank: number): SearchHit {
  return { provider, url, rank };
}

const LIMITS = { maxHits: 4, timeoutMs: 1000 };
const QUERY = { text: "what is alpha?", ownerId: "owner-a" };

function stub(name: string, behavior: () => Promise<SearchHit[]>): SearchProvider {
  return { name, search: behavior };
}

describe("mergeSearchHits (pure)", () => {
  it("interleaves in provider order, dedups by exact URL, caps", () => {
    const a = [hit("wikipedia", "https://a.test/1", 0), hit("wikipedia", "https://a.test/2", 1)];
    const b = [hit("marginalia", "https://a.test/2", 0), hit("marginalia", "https://b.test/1", 1)];
    const merged = mergeSearchHits([a, b], 10);
    // round-robin: a0 (new) → b0 (a.test/2, new here — a1 will dedup) →
    // a1 (dedup skip) → b1 (new)
    expect(merged.map((h) => h.url)).toEqual([
      "https://a.test/1",
      "https://a.test/2",
      "https://b.test/1",
    ]);
    expect(merged.map((h) => h.provider)).toEqual(["wikipedia", "marginalia", "marginalia"]);
  });

  it("caps the merged pool, keeping the interleaved diversity", () => {
    const a = [0, 1, 2].map((i) => hit("wikipedia", `https://a.test/${i}`, i));
    const b = [0, 1, 2].map((i) => hit("marginalia", `https://b.test/${i}`, i));
    const merged = mergeSearchHits([a, b], 4);
    // cap 4 over interleaved order: a0, b0, a1, b1 — two per provider
    expect(merged.map((h) => h.provider)).toEqual([
      "wikipedia",
      "marginalia",
      "wikipedia",
      "marginalia",
    ]);
  });
});

describe("createMergedSearchProvider (composite)", () => {
  it("asks each provider for the full limit and merges; provenance preserved", async () => {
    const asked: string[] = [];
    const a = stub("wikipedia", async () => {
      asked.push("wikipedia");
      return [hit("wikipedia", "https://a.test/1", 0)];
    });
    const b = stub("marginalia", async () => {
      asked.push("marginalia");
      return [hit("marginalia", "https://b.test/1", 0)];
    });
    const merged = createMergedSearchProvider([a, b]);
    expect(merged.name).toBe("merged(wikipedia+marginalia)");
    const hits = await merged.search(QUERY, LIMITS);
    expect(asked).toEqual(["wikipedia", "marginalia"]);
    expect(hits.map((h) => h.provider)).toEqual(["wikipedia", "marginalia"]);
  });

  it("degrades to the survivor when one provider fails — degradation visible in provenance", async () => {
    const a = stub("wikipedia", async () => {
      throw new Error("wikipedia exploded");
    });
    const b = stub("marginalia", async () => [hit("marginalia", "https://b.test/1", 0)]);
    const merged = createMergedSearchProvider([a, b]);
    const hits = await merged.search(QUERY, LIMITS);
    expect(hits.map((h) => h.provider)).toEqual(["marginalia"]); // receipts show it
  });

  it("throws the typed error only when EVERY provider fails", async () => {
    const a = stub("wikipedia", async () => Promise.reject(new Error("down")));
    const b = stub("marginalia", async () => Promise.reject(new Error("down")));
    const merged = createMergedSearchProvider([a, b]);
    await expect(merged.search(QUERY, LIMITS)).rejects.toThrow(MergedSearchError);
  });

  it("propagates cancellation instead of degrading on it", async () => {
    const abortLike = (): never => {
      const e = new Error("aborted");
      (e as { kind?: string }).kind = "aborted";
      throw e;
    };
    const a = stub("wikipedia", async () => abortLike());
    const b = stub("marginalia", async () => [hit("marginalia", "https://b.test/1", 0)]);
    const merged = createMergedSearchProvider([a, b]);
    await expect(merged.search(QUERY, LIMITS)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("refuses single-provider or duplicate compositions", () => {
    const a = stub("wikipedia", async () => []);
    expect(() => createMergedSearchProvider([a] as never)).toThrow(/at least two/);
    expect(() => createMergedSearchProvider([a, a])).toThrow(/distinct/);
  });
});

describe("search-health receipt (SRC-17)", () => {
  it("lastHealth() records each provider's outcome for the most recent search call", async () => {
    const a = stub("wikipedia", async () => [hit("wikipedia", "https://a.test/1", 0)]);
    const b = stub("marginalia", async () => [hit("marginalia", "https://b.test/1", 0)]);
    const merged = createMergedSearchProvider([a, b]);
    await merged.search(QUERY, LIMITS);
    expect(merged.lastHealth()).toEqual([
      { provider: "wikipedia", ok: true },
      { provider: "marginalia", ok: true },
    ]);
  });

  it("a failing provider is recorded with its error message; the run still succeeds", async () => {
    const a = stub("wikipedia", async () => {
      throw new Error("wikipedia exploded");
    });
    const b = stub("marginalia", async () => [hit("marginalia", "https://b.test/1", 0)]);
    const merged = createMergedSearchProvider([a, b]);
    const hits = await merged.search(QUERY, LIMITS);
    expect(hits.map((h) => h.provider)).toEqual(["marginalia"]);
    const health = merged.lastHealth();
    expect(health[0]).toMatchObject({ provider: "wikipedia", ok: false });
    expect(String(health[0]?.error)).toContain("wikipedia exploded");
    expect(health[1]).toEqual({ provider: "marginalia", ok: true });
  });

  it("health resets per search call and persists readable after an all-fail throw", async () => {
    let fail = true;
    const a = stub("wikipedia", async () => {
      if (fail) throw new Error("down-a");
      return [hit("wikipedia", "https://a.test/1", 0)];
    });
    const b = stub("marginalia", async () => {
      if (fail) throw new Error("down-b");
      return [hit("marginalia", "https://b.test/1", 0)];
    });
    const merged = createMergedSearchProvider([a, b]);
    await expect(merged.search(QUERY, LIMITS)).rejects.toThrow(MergedSearchError);
    expect(merged.lastHealth().map((h) => h.error)).toEqual(["down-a", "down-b"]);
    fail = false;
    await merged.search(QUERY, LIMITS);
    expect(merged.lastHealth().every((h) => h.ok)).toBe(true);
  });
});
