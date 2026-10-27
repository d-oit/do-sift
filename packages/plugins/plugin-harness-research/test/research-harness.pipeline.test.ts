/** Research pipeline, passage extraction, kernel round-trip, clock sanity, and embedding indexing (SRC-01, RET-03). */
import { describe, expect, it } from "vitest";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import { Kernel } from "@do-sift/kernel";
import { searchByEmbedding, type TextEmbedder } from "@do-sift/storage";
import harnessJson from "../plugin.json" with { type: "json" };
import {
  createResearchHarness,
  extractPassages,
  type ResearchHarnessInstance,
} from "../src/index.js";
import {
  T0,
  client,
  repos,
  budgets,
  PAGE_A,
  PAGE_B,
  makeDeps,
} from "./research-harness-support.js";
describe("research pipeline (SRC-01)", () => {
  it("stores evidence with provenance for every fetched source, zero model calls", async () => {
    const { harness } = await makeDeps();
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);

    const summary = await harness.run({ ownerId: "owner-a", question: "what is alpha?" });
    expect(summary).toMatchObject({
      hits: 4,
      denied: 1, // linkedin refused, never fetched
      fetches: 2, // a.test + b.test (c.test blocked by maxFetches)
      skippedBudget: 1,
      fetchErrors: 0,
      documentsStored: 2,
      passagesStored: 3,
    });

    const docs = await repos.documents.list("owner-a");
    expect(docs).toHaveLength(2);
    const docA = docs.find((d) => d.canonicalUrl === "https://a.test/page");
    expect(docA).toBeDefined();
    expect(docA?.title).toBe("Page A");
    expect(docA?.rawMime).toBe("text/html");
    expect(docA?.contentHash).toHaveLength(64); // sha256 hex
    expect(docA?.publishedOrigin).toBeUndefined();

    const passages = await repos.passages.listByDocument("owner-a", docA?.id ?? "");
    expect(passages).toHaveLength(2);
    expect(passages[0]?.excerpt).toContain("Alpha is the first paragraph");
    expect(passages.every((p) => p.ownerId === "owner-a" && p.extractionStatus === "ok")).toBe(
      true,
    );
  });

  it("never fetches default-deny sites", async () => {
    const { harness, fetchLog } = await makeDeps();
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 3 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    await harness.run({ ownerId: "owner-a", question: "q" });
    // Host-exact (and subdomain) assertion, not a URL substring: a URL like
    // https://example.test/?ref=linkedin.com must not be able to satisfy or
    // defeat the default-deny check.
    const isLinkedInHost = (url: string): boolean =>
      /(^|\.)linkedin\.com$/iu.test(new URL(url).hostname);
    expect(fetchLog.every((url) => !isLinkedInHost(url))).toBe(true);
  });

  it("continues past fetch failures and records them", async () => {
    const { harness, ownerId } = await makeDeps({
      ownerId: "owner-fail",
      fetchPage: async (url) => {
        if (url !== "https://b.test/page") throw new Error("boom");
        return { text: PAGE_B, contentType: "text/plain" };
      },
    });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    const summary = await harness.run({ ownerId, question: "q" });
    expect(summary).toMatchObject({ fetchErrors: 2, documentsStored: 1 });
  });

  it("reserves budget before and settles actual fetches after", async () => {
    const { harness, ownerId } = await makeDeps({ ownerId: "owner-budget", budget: budgets });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    const summary = await harness.run({ ownerId, question: "q" });
    expect(summary.budgetReservationId).toBeDefined();

    const rows = await client.execute({
      sql: "SELECT kind, state, search_calls, fetches FROM usage_ledger WHERE owner_id = ? ORDER BY kind",
      args: [ownerId],
    });
    const kinds = rows.rows.map((r) => `${String(r.kind)}:${String(r.state)}`);
    expect(kinds).toEqual(["reservation:settled", "settlement:settled"]);
    const settlement = rows.rows.find((r) => String(r.kind) === "settlement");
    expect(Number(settlement?.search_calls)).toBe(1);
    expect(Number(settlement?.fetches)).toBe(2);
  });

  it("refuses to run before activation", async () => {
    const { harness } = await makeDeps();
    await expect(harness.run({ ownerId: "owner-a", question: "q" })).rejects.toThrow(
      /not activated/,
    );
  });

  it("uses an injected extractor (SRC-03) and stores its statuses", async () => {
    // dedicated owner: the shared in-file DB holds "Alpha…" passages from
    // earlier tests, so this test asserts only on rows it created
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES ('owner-extract', 'Extract', '2026-09-09T00:00:00Z') ON CONFLICT(id) DO NOTHING",
    });
    const { harness } = await makeDeps({
      extract: (text) =>
        text
          .split(/\r?\n\r?\n+/u)
          .map((block) => block.replace(/\s+/gu, " ").trim())
          .filter((block) => block.startsWith("Beta") === false) // drop Beta
          .map((text) => ({ text, status: "partial" as const })),
    });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    const summary = await harness.run({ ownerId: "owner-extract", question: "q" });
    // PAGE_A yields 1 passage (Beta dropped), PAGE_B yields 1 → both "partial"
    expect(summary.passagesStored).toBe(2);
    const rows = await client.execute(
      "SELECT extraction_status FROM passages WHERE owner_id = 'owner-extract'",
    );
    expect(rows.rows.map((r) => String(r.extraction_status))).toEqual(["partial", "partial"]);
  });
});

describe("extractPassages", () => {
  it("splits paragraphs, drops short fragments, caps count and length", () => {
    const long = "x".repeat(9000);
    const text = ["short", PAGE_A, long].join("\n\n");
    const out = extractPassages(text);
    expect(out).toHaveLength(3); // "short" dropped; PAGE_A is two paragraphs; long truncated
    expect(out[2]).toHaveLength(8192);
  });
});

describe("kernel round-trip", () => {
  it("registers, activates, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: ResearchHarnessInstance | undefined;
    kernel.register(harnessJson, (ctx) => {
      instance = createResearchHarness(ctx, {
        search: new FakeSearchProvider({ hits: [] }),
        fetchPage: async () => ({ text: "", contentType: "text/plain" }),
        repositories: repos,
      });
      return instance;
    });
    await kernel.activate("harness-research");
    expect(kernel.isActivated("harness-research")).toBe(true);
    await kernel.deactivate("harness-research");
    expect(kernel.isActivated("harness-research")).toBe(false);
    await expect(instance?.run({ ownerId: "owner-a", question: "q" })).rejects.toThrow(
      /not activated/,
    );
  });
});

describe("deterministic clock sanity", () => {
  it("keeps T0 fixed for reproducible fixtures", () => {
    expect(T0).toBe(Date.parse("2026-09-09T12:00:00.000Z"));
  });
});

describe("embedding indexing (RET-03)", () => {
  const ACTIVATE = {
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 2 },
  } as unknown as Parameters<typeof createResearchHarness>[0];

  async function ensureOwner(id: string): Promise<void> {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-09T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }

  it("indexes newly stored passages when an embedder is provided", async () => {
    await ensureOwner("owner-emb");
    const embedder: TextEmbedder = {
      modelId: "fake-embed-1",
      async embedPassages(texts) {
        return texts.map((t) => [t.includes("Alpha") ? 1 : 0, t.includes("Alpha") ? 0 : 1, 0.5]);
      },
      async embedQuery() {
        return [1, 0, 0.5];
      },
    };
    const { harness } = await makeDeps({ embedder });
    await harness.activate(ACTIVATE);

    const summary = await harness.run({ ownerId: "owner-emb", question: "what is alpha?" });
    expect(summary.passagesStored).toBe(3);
    expect(summary.embedded).toBe(3); // all new passages indexed

    // the stored passages are retrievable through the vector path, best-match first
    const hits = await searchByEmbedding(client, "owner-emb", "fake-embed-1", [1, 0, 0.5], 10);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.excerpt).toContain("Alpha");
  });

  it("an embedder failure never fails the run (honest degradation)", async () => {
    const events: string[] = [];
    const embedder: TextEmbedder = {
      modelId: "boom-1",
      async embedPassages() {
        throw new Error("onnx hiccup");
      },
      async embedQuery() {
        throw new Error("onnx hiccup");
      },
    };
    const { harness, ownerId } = await makeDeps({
      ownerId: "owner-embed-fail",
      embedder,
      onEvent: (name) => events.push(name),
    });
    await harness.activate(ACTIVATE);

    const summary = await harness.run({ ownerId, question: "what is alpha?" });
    expect(summary.fetches).toBe(2);
    expect(summary.documentsStored).toBe(2);
    expect(summary.embedded).toBeUndefined(); // degraded, not failed
    expect(events).toContain("research.embeddings-failed");
  });
});
