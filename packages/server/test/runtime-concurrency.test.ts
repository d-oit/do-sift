/**
 * Per-run source callbacks under overlap (issue #158).
 *
 * The runtime composes one harness for the process, but each `runResearch`
 * call must own its callback and its event stream. These tests overlap runs
 * with distinct questions and URLs and assert that no source event reaches
 * another run's callback.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { SearchHit, SearchProvider, SearchQuery } from "@do-sift/contracts";
import { FakeModelProvider } from "@do-sift/fake-providers";
import { applyMigrations, loadMigrations } from "@do-sift/storage";
import { createRuntime } from "../src/index.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO owners (id, display_name, created_at) VALUES ('owner-a', 'Owner A', '2026-11-17T00:00:00Z') ON CONFLICT(id) DO NOTHING",
    args: [],
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Each question maps to its own URL and page text; the delay forces overlap. */
class QuestionSearch implements SearchProvider {
  readonly name = "question-search";

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const key = query.text.includes("alpha") ? "alpha" : "beta";
    await delay(key === "alpha" ? 25 : 5);
    return [
      {
        url: `https://${key}.test/page`,
        title: `Page ${key}`,
        snippet: `snippet ${key}`,
        provider: this.name,
        rank: 0,
      },
    ];
  }
}

function runtime() {
  return createRuntime({
    client,
    search: new QuestionSearch(),
    fetchPage: async (url) => {
      const key = url.includes("alpha") ? "alpha" : "beta";
      await delay(key === "alpha" ? 15 : 1);
      return {
        text: `${key.toUpperCase()} FIRST PASSAGE about the question.\n\n${key.toUpperCase()} SECOND PASSAGE.`,
        contentType: "text/html",
      };
    },
    model: new FakeModelProvider(),
    // No budget in this test: the in-memory libSQL client has one connection,
    // so two overlapping reservation transactions would be a storage
    // limitation, not a callback leak. Budget isolation has its own suite.
    maxFetches: 2,
  });
}

describe("runtime concurrency", () => {
  it("delivers each source only to the run that fetched it", async () => {
    const r = await runtime();
    const events = { alpha: [] as string[], beta: [] as string[] };

    const [alpha, beta] = await Promise.all([
      r.runResearch("owner-a", "question alpha", (source) => events.alpha.push(source.url)),
      r.runResearch("owner-a", "question beta", (source) => events.beta.push(source.url)),
    ]);

    expect(alpha.documentsStored).toBe(1);
    expect(beta.documentsStored).toBe(1);
    expect(events.alpha).toEqual(["https://alpha.test/page"]);
    expect(events.beta).toEqual(["https://beta.test/page"]);
  });

  it("does not retain one run's callback for the next run", async () => {
    const r = await runtime();
    const first: string[] = [];
    await r.runResearch("owner-a", "question alpha", (source) => first.push(source.url));

    const second: string[] = [];
    await r.runResearch("owner-a", "question beta", (source) => second.push(source.url));

    expect(first).toEqual(["https://alpha.test/page"]);
    expect(second).toEqual(["https://beta.test/page"]);
  });

  it("runs without a callback without leaking events into a later run", async () => {
    const r = await runtime();
    await r.runResearch("owner-a", "question beta");
    const captured: string[] = [];
    await r.runResearch("owner-a", "question alpha", (source) => captured.push(source.url));
    expect(captured).toEqual(["https://alpha.test/page"]);
  });
});
