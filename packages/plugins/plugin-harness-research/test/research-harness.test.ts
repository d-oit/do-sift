import { createClient, type Client } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import { Kernel } from "@do-sift/kernel";
import {
  BudgetService,
  Repositories,
  applyMigrations,
  loadMigrations,
  searchByEmbedding,
  type TextEmbedder,
} from "@do-sift/storage";
import harnessJson from "../plugin.json" with { type: "json" };
import {
  createResearchHarness,
  extractPassages,
  type ResearchHarnessInstance,
} from "../src/index.js";

const T0 = Date.parse("2026-09-09T12:00:00.000Z");

let client: Client;
let repos: Repositories;
let budgets: BudgetService;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  budgets = new BudgetService(client, {
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    maxSearchCalls: 100,
    maxFetches: 100,
  });
  for (const id of ["owner-a"]) {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-09T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }
});

const PAGE_A = [
  "Alpha is the first paragraph of page A and carries the primary claim about the topic at hand.",
  "Beta is the second paragraph of page A with supporting detail and a secondary observation.",
].join("\n\n");

const PAGE_B =
  "Gamma is the only paragraph of page B and it is long enough to qualify as evidence here.";

function makeDeps(
  overrides: {
    fetchPage?: (url: string) => Promise<{ text: string; contentType: string }>;
    maxHits?: number;
    budget?: BudgetService;
    extract?: (text: string) => Array<{ text: string; status: "ok" | "partial" }>;
    embedder?: TextEmbedder;
    onEvent?: (name: string, payload?: unknown) => void;
  } = {},
) {
  const fetchLog: string[] = [];
  const search = new FakeSearchProvider({
    hits: [
      { url: "https://a.test/page", title: "Page A", snippet: "alpha", rank: 0 },
      { url: "https://www.linkedin.com/posts/x", title: "Denied", rank: 1 },
      {
        url: "https://b.test/page",
        title: "Page B",
        rank: 2,
        provider: "fake-search",
      },
      { url: "https://c.test/page", title: "Never fetched if capped", rank: 3 },
    ],
  });
  const fetchPage =
    overrides.fetchPage ??
    (async (url: string) => {
      fetchLog.push(url);
      if (url === "https://a.test/page") return { text: PAGE_A, contentType: "text/html" };
      if (url === "https://b.test/page") return { text: PAGE_B, contentType: "text/plain" };
      throw new Error("404");
    });
  const harness = createResearchHarness(
    {
      events: {
        emit: (name: string, payload?: unknown) => overrides.onEvent?.(name, payload),
      },
      config: { maxHits: overrides.maxHits ?? 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0],
    {
      search,
      fetchPage,
      repositories: repos,
      budget: overrides.budget,
      extract: overrides.extract,
      ...(overrides.embedder === undefined ? {} : { embedder: overrides.embedder }),
    },
  );
  return { harness, fetchLog };
}

describe("research pipeline (SRC-01)", () => {
  it("stores evidence with provenance for every fetched source, zero model calls", async () => {
    const { harness } = makeDeps();
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
    const { harness, fetchLog } = makeDeps();
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 3 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    await harness.run({ ownerId: "owner-a", question: "q" });
    expect(fetchLog.every((url) => !url.includes("linkedin.com"))).toBe(true);
  });

  it("continues past fetch failures and records them", async () => {
    const { harness } = makeDeps({
      fetchPage: async (url) => {
        if (url !== "https://b.test/page") throw new Error("boom");
        return { text: PAGE_B, contentType: "text/plain" };
      },
    });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    const summary = await harness.run({ ownerId: "owner-a", question: "q" });
    expect(summary).toMatchObject({ fetchErrors: 2, documentsStored: 1 });
  });

  it("reserves budget before and settles actual fetches after", async () => {
    const { harness } = makeDeps({ budget: budgets });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof createResearchHarness>[0]);
    const summary = await harness.run({ ownerId: "owner-a", question: "q" });
    expect(summary.budgetReservationId).toBeDefined();

    const rows = await client.execute(
      "SELECT kind, state, search_calls, fetches FROM usage_ledger WHERE owner_id = 'owner-a' ORDER BY kind",
    );
    const kinds = rows.rows.map((r) => `${String(r.kind)}:${String(r.state)}`);
    expect(kinds).toEqual(["reservation:settled", "settlement:settled"]);
    const settlement = rows.rows.find((r) => String(r.kind) === "settlement");
    expect(Number(settlement?.search_calls)).toBe(1);
    expect(Number(settlement?.fetches)).toBe(2);
  });

  it("refuses to run before activation", async () => {
    const { harness } = makeDeps();
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
    const { harness } = makeDeps({
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
    const { harness } = makeDeps({ embedder });
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
    const { harness } = makeDeps({
      embedder,
      onEvent: (name) => events.push(name),
    });
    await harness.activate(ACTIVATE);

    const summary = await harness.run({ ownerId: "owner-a", question: "what is alpha?" });
    expect(summary.fetches).toBe(2);
    expect(summary.documentsStored).toBe(2);
    expect(summary.embedded).toBeUndefined(); // degraded, not failed
    expect(events).toContain("research.embeddings-failed");
  });
});

describe("evidence linkage (ANS-07, R-15/F9)", () => {
  it("records a completed search request row and stamps stored documents with its id", async () => {
    await repos.owners.ensure("owner-link", "Link Owner");
    const { harness } = makeDeps();
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
