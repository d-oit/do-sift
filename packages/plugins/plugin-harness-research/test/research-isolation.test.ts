/**
 * Issue #158 (plan 061, RSC-01): two overlapping runs on one harness
 * instance must not cross-deliver source events. A shared callback slot
 * would show up as last-writer-wins (2N events on one collector, 0 on the
 * other); per-run routing delivers N and N.
 */
import { describe, expect, it } from "vitest";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import { createResearchHarness, type ResearchSourceEvent } from "../src/index.js";
import { client, makeDeps, PAGE_A, PAGE_B, repos } from "./research-harness-support.js";

describe("research source-callback isolation (issue #158)", () => {
  it("delivers each overlapping run's sources to its own callback", async () => {
    const { harness } = await makeDeps({
      ownerId: "owner-isolation-a",
      fetchPage: async (url: string) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (url === "https://a.test/page") return { text: PAGE_A, contentType: "text/html" };
        if (url === "https://b.test/page") return { text: PAGE_B, contentType: "text/plain" };
        throw new Error("404");
      },
    });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof harness.activate>[0]);

    const collectedA: ResearchSourceEvent[] = [];
    const collectedB: ResearchSourceEvent[] = [];
    const [summaryA, summaryB] = await Promise.all([
      harness.run({
        ownerId: "owner-isolation-a",
        question: "What does page A claim about the topic at hand?",
        onSource: (source) => {
          collectedA.push(source);
        },
      }),
      harness.run({
        ownerId: "owner-isolation-a",
        question: "What does page B say that is long enough to qualify?",
        onSource: (source) => {
          collectedB.push(source);
        },
      }),
    ]);

    expect(summaryA.ownerId).toBe("owner-isolation-a");
    expect(summaryB.ownerId).toBe("owner-isolation-a");
    expect(collectedA.length).toBeGreaterThan(0);
    expect(collectedB.length).toBeGreaterThan(0);
    expect(collectedA.length).toBe(collectedB.length);
  });

  it("does not consult a deps-level onSource (plan 062, RSO-01)", async () => {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-09T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: ["owner-isolation-b", "owner-isolation-b"],
    });
    const stray: ResearchSourceEvent[] = [];
    const deps = {
      search: new FakeSearchProvider({
        hits: [{ url: "https://a.test/page", title: "Page A", snippet: "alpha", rank: 0 }],
      }),
      fetchPage: async () => ({ text: PAGE_A, contentType: "text/html" as const }),
      repositories: repos,
      onSource: (source: ResearchSourceEvent) => {
        stray.push(source);
      },
    };
    const harness = createResearchHarness(
      { events: { emit: () => {} }, config: {} } as unknown as Parameters<
        typeof createResearchHarness
      >[0],
      deps,
    );
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 2 },
    } as unknown as Parameters<typeof harness.activate>[0]);
    const summary = await harness.run({
      ownerId: "owner-isolation-b",
      question: "What does page A claim about the topic at hand?",
    });
    expect(summary.documentsStored).toBeGreaterThan(0);
    expect(stray).toEqual([]);
  });
});
