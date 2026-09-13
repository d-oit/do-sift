import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import fixtureJson from "../plugin.json" with { type: "json" };
import { TermsGateError, createFixtureSearch, type FixtureSearchInstance } from "../src/index.js";

const FIXTURES = [
  {
    url: "https://docs.test/libsql/fts",
    title: "FTS5 full-text search in libSQL",
    snippet: "libSQL supports FTS5 virtual tables for full-text search over stored documents.",
  },
  {
    url: "https://docs.test/turso/pricing",
    title: "Turso pricing and free tier",
    snippet: "The free tier includes 5 GB storage and row-read quotas per month.",
  },
  {
    url: "https://blog.test/retrieval",
    title: "Hybrid retrieval baseline",
    snippet: "A hybrid retrieval baseline combines FTS5 keyword scoring with embeddings later.",
  },
];

const TERMS = { termsAcceptedAt: "2026-09-09", sourcesEntry: "Search providers (fixtures)" };

async function activatedHarness(
  configOverrides: Record<string, unknown> = {},
): Promise<FixtureSearchInstance> {
  const plugin = createFixtureSearch();
  await plugin.activate({
    pluginName: "search-fixture",
    config: { ...TERMS, fixtures: FIXTURES, ...configOverrides },
    events: { emit: () => {} },
  } as unknown as Parameters<FixtureSearchInstance["activate"]>[0]);
  return plugin;
}

const LIMITS = { maxHits: 6, timeoutMs: 10_000 };

describe("terms gate (no sources.md entry, no activation)", () => {
  it("refuses activation without terms metadata", async () => {
    const plugin = createFixtureSearch();
    await expect(
      plugin.activate({
        pluginName: "search-fixture",
        config: { fixtures: FIXTURES },
      } as unknown as Parameters<FixtureSearchInstance["activate"]>[0]),
    ).rejects.toBeInstanceOf(TermsGateError);
  });

  it("refuses an empty sourcesEntry and a malformed date", async () => {
    await expect(activatedHarness({ sourcesEntry: "  " })).rejects.toThrow(/sourcesEntry/);
    await expect(activatedHarness({ termsAcceptedAt: "sometime" })).rejects.toThrow(
      /termsAcceptedAt/,
    );
  });

  it("activates with a recorded terms date and sources entry", async () => {
    const plugin = await activatedHarness();
    expect(plugin).toBeDefined();
    expect(plugin.queries).toHaveLength(0); // no queries recorded before use
  });
});

describe("fixture retrieval", () => {
  it("ranks keyword matches deterministically and respects maxHits", async () => {
    const plugin = await activatedHarness();
    const hits = await plugin.search({ text: "fts5 full-text search", ownerId: "owner-1" }, LIMITS);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.url).toBe("https://docs.test/libsql/fts");
    // ranked output carries fresh rank values
    expect(hits.map((h) => h.rank)).toEqual(hits.map((_, i) => i));

    const capped = await plugin.search(
      { text: "fts5 full-text search", ownerId: "owner-1" },
      { maxHits: 1, timeoutMs: 10_000 },
    );
    expect(capped).toHaveLength(1);
  });

  it("returns nothing for unrelated or tokenless queries", async () => {
    const plugin = await activatedHarness();
    expect(
      await plugin.search({ text: "quantum pickle astrology", ownerId: "owner-1" }, LIMITS),
    ).toEqual([]);
    expect(await plugin.search({ text: "a ?!", ownerId: "owner-1" }, LIMITS)).toEqual([]);
  });

  it("records queries with owner attribution and honors pre-abort", async () => {
    const plugin = await activatedHarness();
    await plugin.search({ text: "turso pricing", ownerId: "owner-1" }, LIMITS);
    expect(plugin.queries).toEqual([{ text: "turso pricing", ownerId: "owner-1" }]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      plugin.search({ text: "q", ownerId: "owner-1" }, LIMITS, controller.signal),
    ).rejects.toThrow(/aborted/);

    const fresh = createFixtureSearch();
    await expect(fresh.search({ text: "q", ownerId: "owner-1" }, LIMITS)).rejects.toThrow(
      /not activated/,
    );
  });

  it("validates fixtures against the SearchHit contract at activation", async () => {
    await expect(
      activatedHarness({ fixtures: [{ url: "not-a-url", title: "bad" }] }),
    ).rejects.toThrow();
  });
});

describe("zero-capability proof + kernel round-trip", () => {
  it("declares no capabilities at all (offline by manifest)", () => {
    expect(fixtureJson.capabilities).toEqual([]);
    expect(fixtureJson.kind).toBe("search");
  });

  it("registers, activates, searches, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: FixtureSearchInstance | undefined;
    kernel.register({ ...fixtureJson, config: { ...TERMS, fixtures: FIXTURES } }, () => {
      instance = createFixtureSearch();
      return instance;
    });
    await kernel.activate("search-fixture");
    const hits = await instance?.search({ text: "hybrid retrieval", ownerId: "owner-1" }, LIMITS);
    expect(hits?.[0]?.url).toBe("https://blog.test/retrieval");
    await kernel.deactivate("search-fixture");
    await expect(instance?.search({ text: "q", ownerId: "owner-1" }, LIMITS)).rejects.toThrow(
      /not activated/,
    );
  });
});
