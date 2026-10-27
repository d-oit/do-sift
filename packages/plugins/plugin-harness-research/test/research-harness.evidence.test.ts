/** Evidence linkage and relevance, noise classification, and the source-card receipt (ANS-07, SRC-11, SRC-12, SRC-14). */
import { describe, expect, it } from "vitest";
import { type TextEmbedder } from "@do-sift/storage";
import { createResearchHarness } from "../src/index.js";
import { client, repos, PAGE_B, makeDeps } from "./research-harness-support.js";
describe("evidence linkage (ANS-07, R-15/F9)", () => {
  it("records a completed search request row and stamps stored documents with its id", async () => {
    await repos.owners.ensure("owner-link", "Link Owner");
    const { harness } = await makeDeps();
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);

    const summary = await harness.run({ ownerId: "owner-link", question: "what is alpha?" });
    expect(summary.requestId).toEqual(expect.any(String));

    const req = await repos.requests.get("owner-link", summary.requestId ?? "");
    expect(req).toMatchObject({
      mode: "search",
      status: "completed",
      question: "what is alpha?",
    });

    const docs = await repos.documents.list("owner-link");
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) expect(doc.requestId).toBe(summary.requestId);
  });

  it("fails the request row when the search fails and stores nothing", async () => {
    await repos.owners.ensure("owner-fail", "Fail Owner");
    const harness = createResearchHarness(
      { events: { emit: () => {} }, config: {} } as unknown as Parameters<
        typeof createResearchHarness
      >[0],
      {
        search: {
          name: "throwing",
          search: async () => {
            throw new Error("rate limited");
          },
        } as never,
        fetchPage: async () => {
          throw new Error("unreachable");
        },
        repositories: repos,
      },
    );
    await harness.activate({
      events: { emit: () => {} },
      config: {},
    } as unknown as Parameters<typeof createResearchHarness>[0]);

    await expect(
      harness.run({ ownerId: "owner-fail", question: "doomed question?" }),
    ).rejects.toThrow(/rate limited/);

    // No completed search run for this question; the row exists and is failed.
    const rows = await client.execute({
      sql: "SELECT status FROM requests WHERE owner_id = ? AND question = ?",
      args: ["owner-fail", "doomed question?"],
    });
    expect(rows.rows.map((r) => String(r.status))).toEqual(["failed"]);
  });
});

describe("evidence relevance (SRC-11)", () => {
  const ACTIVATE = {
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 2 },
  } as unknown as Parameters<typeof createResearchHarness>[0];

  async function ensureOwner(id: string): Promise<void> {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-14T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }

  it("computes and stores the player-question ↔ extract similarity (lead-window by design)", async () => {
    await ensureOwner("owner-rel");
    // Deterministic keyed fake: the question pairs at cosine 1 with [1,0,0];
    // the PAGE_A extract pairs at cosine 0, the PAGE_B extract at 0.9 —
    // both STORED unconditionally (store-with-flag: exclusion is read-time;
    // the receipt is the receipt). The extract is passed WHOLE and UNCHUNKED —
    // lead-window similarity by design (see plans/003-004-src-ans.md SRC-11).
    const embedder: TextEmbedder = {
      modelId: "fake-rel-1",
      async embedPassages(texts) {
        return texts.map((t) => (t.includes("Alpha") ? [0, 1, 0] : [0.9, 0.43589, 0]));
      },
      async embedQuery() {
        return [1, 0, 0];
      },
    };
    const { harness } = await makeDeps({ embedder });
    await harness.activate(ACTIVATE);

    const summary = await harness.run({ ownerId: "owner-rel", question: "what is alpha?" });
    expect(summary.fetches).toBe(2); // run succeeds — store-with-flag, receipts kept
    expect(summary.documentsStored).toBe(2);

    const docs = await repos.documents.list("owner-rel");
    const docA = docs.find((d) => d.canonicalUrl === "https://a.test/page");
    const docB = docs.find((d) => d.canonicalUrl === "https://b.test/page");
    expect(docA?.relevanceScore).toBeCloseTo(0); // below the floor — still stored
    expect(docB?.relevanceScore).toBeCloseTo(0.9);
  });

  it("an embedder failure never fails the run or the store (advisory degradation)", async () => {
    await ensureOwner("owner-rel2");
    const events: string[] = [];
    const embedder: TextEmbedder = {
      modelId: "boom-rel-1",
      async embedPassages() {
        throw new Error("onnx hiccup");
      },
      async embedQuery() {
        throw new Error("onnx hiccup");
      },
    };
    const { harness } = await makeDeps({
      embedder,
      onEvent: (name) => events.push(name),
    });
    await harness.activate(ACTIVATE);

    const summary = await harness.run({ ownerId: "owner-rel2", question: "what is alpha?" });
    expect(summary.documentsStored).toBe(2); // stored WITHOUT a score
    const docs = await repos.documents.list("owner-rel2");
    for (const doc of docs) expect(doc.relevanceScore).toBeUndefined();
    expect(events).toContain("research.relevance-failed"); // emitted, continued
  });
});

describe("noise classification at store time (SRC-12)", () => {
  const ACTIVATE = {
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 2 },
  } as unknown as Parameters<typeof createResearchHarness>[0];

  async function ensureOwner(id: string): Promise<void> {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-15T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }

  it("flags noise-shaped chunks at store time and keeps the receipts (store-with-flag)", async () => {
    await ensureOwner("owner-noise");
    // Page A carries the run-006 case-06 store shape: a nav-list
    // concatenation paragraph and a clean prose paragraph (default
    // extraction splits on blank lines, so each lands as its own
    // passage). Page B stays plain prose.
    const NOISE_PAGE = [
      "List of tallest mountains in the Solar System List of mountain peaks by prominence " +
        "List of highest mountains on Earth Summits farthest from the Earth's center",
      "Mount Everest is the highest mountain above sea level, at 8,848 metres, and it is " +
        "not the summit farthest from the Earth's center.",
    ].join("\n\n");
    const { harness } = await makeDeps({
      fetchPage: async (url) =>
        url === "https://a.test/page"
          ? { text: NOISE_PAGE, contentType: "text/html" }
          : { text: PAGE_B, contentType: "text/html" },
    });
    await harness.activate(ACTIVATE);

    const summary = await harness.run({ ownerId: "owner-noise", question: "tallest mountain" });
    expect(summary.passagesStored).toBe(3); // receipts kept — nothing dropped

    const docs = await repos.documents.list("owner-noise");
    const doc = docs.find((d) => d.canonicalUrl === "https://a.test/page");
    if (doc === undefined) throw new Error("document not stored");
    const passages = await repos.passages.listByDocument("owner-noise", doc.id);
    const flagged = passages.find((p) => p.noiseClass === "nav-list");
    const clean = passages.find((p) => p.noiseClass === undefined);
    expect(flagged?.excerpt.startsWith("List of tallest mountains")).toBe(true);
    expect(clean?.excerpt.startsWith("Mount Everest is the highest")).toBe(true);
  });
});

describe("legacy noise-class backfill at run time (SRC-13)", () => {
  const ACTIVATE = {
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 2 },
  } as unknown as Parameters<typeof createResearchHarness>[0];

  async function ensureOwner(id: string): Promise<void> {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-15T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }

  it("a run backfills the owner's pre-SRC-12 unclassified passages", async () => {
    await ensureOwner("owner-backfill");
    // a legacy row: stored before SRC-12 existed, noise_class NULL
    const legacyDoc = await repos.documents.insert({
      ownerId: "owner-backfill",
      canonicalUrl: "https://legacy.test/page",
      originalUrl: "https://legacy.test/page",
      contentHash: "hash-legacy-noise-001",
      fetchedAt: "2026-09-14T00:00:00Z",
      rawText: "legacy noise",
    });
    const legacyId = await repos.passages.insert({
      ownerId: "owner-backfill",
      documentId: legacyDoc,
      excerpt:
        "List of tallest mountains in the Solar System List of mountain peaks by prominence " +
        "List of highest mountains on Earth",
      extractionStatus: "ok",
    });
    const { harness } = await makeDeps();
    await harness.activate(ACTIVATE);
    const summary = await harness.run({ ownerId: "owner-backfill", question: "tallest mountain" });
    expect(summary.noiseBackfilled).toBe(1);
    expect((await repos.passages.get("owner-backfill", legacyId))?.noiseClass).toBe("nav-list");
  });
});

describe("source-card relevance receipt (SRC-14)", () => {
  const ACTIVATE = {
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 2 },
  } as unknown as Parameters<typeof createResearchHarness>[0];

  async function ensureOwner(id: string): Promise<void> {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-15T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }

  it("onSource carries the raw relevanceScore receipt (undefined without an embedder)", async () => {
    await ensureOwner("owner-card");
    const seen: Array<Record<string, unknown>> = [];
    const { harness } = await makeDeps({
      embedder: {
        modelId: "fake-card-1",
        async embedPassages(texts) {
          return texts.map((t) => (t.includes("Alpha") ? [0, 1, 0] : [0.9, 0.43589, 0]));
        },
        async embedQuery() {
          return [1, 0, 0];
        },
      },
      onSource: (source) => seen.push(source as Record<string, unknown>),
    });
    await harness.activate(ACTIVATE);
    await harness.run({ ownerId: "owner-card", question: "what is alpha?" });
    // The raw score is a receipt — the RUNTIME (floor owner) decides prominence.
    const a = seen.find((s) => s.url === "https://a.test/page");
    const b = seen.find((s) => s.url === "https://b.test/page");
    expect(a?.relevanceScore).toBeCloseTo(0);
    expect(b?.relevanceScore).toBeCloseTo(0.9);

    await ensureOwner("owner-card2");
    const plain: Array<Record<string, unknown>> = [];
    const { harness: plainHarness } = await makeDeps({
      onSource: (source) => plain.push(source as Record<string, unknown>),
    });
    await plainHarness.activate(ACTIVATE);
    await plainHarness.run({ ownerId: "owner-card2", question: "what is alpha?" });
    for (const card of plain) expect(card.relevanceScore).toBeUndefined();
  });
});
