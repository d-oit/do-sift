/**
 * Claim receipts on the answer response (issue #160).
 *
 * The stored answer's citations are the authoritative evidence set. They are
 * checked against the passages that still exist for the owner, so a
 * retention-pruned citation is reported as unresolved rather than being
 * treated as grounded.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
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

function runtime() {
  return createRuntime({
    client,
    search: new FakeSearchProvider({
      hits: [{ url: "https://a.test/page", title: "Page A", snippet: "fts5", rank: 0 }],
    }),
    fetchPage: async () => ({
      text: "FTS5 ranks keyword matches with bm25.\n\nThe bm25 function weighs rarer terms more heavily.",
      contentType: "text/html",
    }),
    model: new FakeModelProvider(),
    maxFetches: 2,
  });
}

describe("answer claim assessment", () => {
  it("marks citations that still exist as supported, without claiming entailment", async () => {
    const r = await runtime();
    await r.runResearch("owner-a", "how does fts5 ranking work?");
    const response = await r.answerResponse("owner-a", "how does fts5 ranking work?");

    expect(response.claimAssessment).toBeDefined();
    expect(response.claimAssessment?.claims).toHaveLength(response.blocks.length);
    expect(response.claimAssessment?.summary.supported).toBe(response.blocks.length);
    expect(response.claimAssessment?.summary.unresolved).toBe(0);
    // "supported" is structural: every cited id exists. No entailment verdict.
    expect(response.claimAssessment?.claims.every((c) => c.support === "supported")).toBe(true);
  });

  it("does not turn a citation into support when the passage no longer exists", async () => {
    const r = await runtime();
    await r.runResearch("owner-a", "how does fts5 ranking work?");
    const first = await r.answerResponse("owner-a", "how does fts5 ranking work?");
    expect(first.claimAssessment?.summary.supported).toBeGreaterThan(0);

    // A pruned source also changes the retrieval set and therefore the cache
    // key, so the next answer re-runs rather than replaying the stored one.
    // What must never happen is a citation being reported as supported when
    // the passage is gone; the structural assessment reports that honestly.
    await client.execute("DELETE FROM passages WHERE owner_id = 'owner-a'");
    const second = await r.answerResponse("owner-a", "how does fts5 ranking work?");
    expect(second.claimAssessment?.summary.supported).toBe(0);
    expect(second.claimAssessment?.claims.every((c) => c.support !== "supported")).toBe(true);
  });

  it("downgrades a producer quote that appears in no cited excerpt (plan 071)", async () => {
    const quotingModel = {
      name: "quoting-fake",
      modelId: "quoting-fake-1",
      calls: [] as Array<{ question: string }>,
      async complete(request: { question: string; passages: Array<{ id: string; text: string }> }) {
        const [first] = request.passages;
        if (first === undefined) throw new Error("no passages for quoting model");
        return {
          blocks: [
            {
              kind: "paragraph" as const,
              text: "Claim with a fabricated span.",
              citations: [first.id],
              quote: "zz-no-such-span-12345",
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, model: "quoting-fake-1", estimated: true },
        };
      },
    };
    const r = await createRuntime({
      client,
      search: new FakeSearchProvider({
        hits: [{ url: "https://a.test/page", title: "Page A", snippet: "fts5", rank: 0 }],
      }),
      fetchPage: async () => ({
        text: "FTS5 ranks keyword matches with bm25.\n\nThe bm25 function weighs rarer terms more heavily.",
        contentType: "text/html",
      }),
      model: quotingModel,
      maxFetches: 2,
    });
    await r.runResearch("owner-a", "how does fts5 ranking work?");
    const response = await r.answerResponse("owner-a", "how does fts5 ranking work?");
    expect(response.claimAssessment?.claims).toHaveLength(1);
    expect(response.claimAssessment?.claims[0]?.quote).toBe("zz-no-such-span-12345");
    expect(response.claimAssessment?.claims[0]?.support).toBe("partially-supported");
    expect(response.claimAssessment?.claims[0]?.reason).toBe("quote-mismatch");
  });

  it("reports no-citation claims rather than treating them as grounded", async () => {
    const r = await runtime();
    await r.runResearch("owner-a", "how does fts5 ranking work?");
    // An answer with no evidence still yields a receipt: every claim is
    // uncited, which is `no-citation`, not `supported`.
    const empty = await createRuntime({
      client,
      search: new FakeSearchProvider({ hits: [] }),
      fetchPage: async () => ({ text: "", contentType: "text/html" }),
      model: new FakeModelProvider(),
    });
    const response = await empty.answerResponse("owner-a", "a question with no stored evidence");
    expect(response.claimAssessment?.summary.claims).toBe(response.blocks.length);
    expect(response.claimAssessment?.claims.every((c) => c.support !== "supported")).toBe(true);
  });
});
