/** Shared in-memory fixture for the research harness plugin tests (SRC-01): seed pages, deps, and clock. */
import { createClient, type Client } from "@libsql/client";
import { beforeAll } from "vitest";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import {
  BudgetService,
  Repositories,
  applyMigrations,
  loadMigrations,
  type TextEmbedder,
} from "@do-sift/storage";
import { createResearchHarness } from "../src/index.js";
export const T0 = Date.parse("2026-09-09T12:00:00.000Z");
export let client: Client;
export let repos: Repositories;
export let budgets: BudgetService;
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
export const PAGE_A = [
  "Alpha is the first paragraph of page A and carries the primary claim about the topic at hand.",
  "Beta is the second paragraph of page A with supporting detail and a secondary observation.",
].join("\n\n");
export const PAGE_B =
  "Gamma is the only paragraph of page B and it is long enough to qualify as evidence here.";
export async function makeDeps(
  overrides: {
    fetchPage?: (url: string) => Promise<{ text: string; contentType: string }>;
    maxHits?: number;
    budget?: BudgetService;
    extract?: (text: string) => Array<{ text: string; status: "ok" | "partial" }>;
    embedder?: TextEmbedder;
    onEvent?: (name: string, payload?: unknown) => void;
    onSource?: (source: { url: string; title?: string | undefined; passageCount: number }) => void;
    /** SRC-25: a fresh owner isolates a test from earlier tests' stored
     * URLs now that cross-run dedup reuses them. */
    ownerId?: string;
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
      ...(overrides.onSource === undefined ? {} : { onSource: overrides.onSource }),
    },
  );
  if (overrides.ownerId !== undefined) {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-09T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [overrides.ownerId, overrides.ownerId],
    });
  }
  return { harness, fetchLog, ownerId: overrides.ownerId ?? "owner-a" };
}
