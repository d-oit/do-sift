import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeModelProvider } from "@do-sift/fake-providers";
import {
  BudgetService,
  Repositories,
  applyMigrations,
  backfillPassageEmbeddings,
  loadMigrations,
  type TextEmbedder,
} from "@do-sift/storage";
import { createAnswerService, AnswerCancelledError, type AnswerServiceDeps } from "../src/index.js";

const QUESTION = "how does fts5 ranking work?";

let client: Client;
let repos: Repositories;
let budgets: BudgetService;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  budgets = new BudgetService(client, {
    maxInputTokens: 20_000,
    maxOutputTokens: 10_000,
    maxSearchCalls: 100,
    maxFetches: 100,
  });
  await repos.owners.ensure("owner-a", "Owner A");
  await repos.owners.ensure("owner-b", "Owner B");
});

async function seedEvidence(ownerId = "owner-a", requestId?: string): Promise<void> {
  const docId = await repos.documents.insert({
    ownerId,
    canonicalUrl: "https://docs.test/fts5",
    originalUrl: "https://docs.test/fts5",
    contentHash: "hash-fts5-ranking-0001",
    fetchedAt: "2026-09-10T00:00:00Z",
    rawText: "FTS5 ranking",
    ...(requestId === undefined ? {} : { requestId }),
  });
  await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt: "FTS5 ranks keyword matches with bm25, where lower scores are better.",
    extractionStatus: "ok",
  });
  await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt: "The bm25 function weighs rarer terms more heavily in the ranking.",
    extractionStatus: "ok",
  });
}

function makeDeps(
  model: FakeModelProvider,
  withBudget = true,
  embedder?: TextEmbedder,
): AnswerServiceDeps {
  return {
    client,
    repositories: repos,
    model,
    budget: withBudget ? budgets : undefined,
    ...(embedder === undefined ? {} : { embedder }),
  };
}

describe("answer service (ANS-03)", () => {
  it("grounded path: validates citations, stores the answer, settles the budget", async () => {
    await seedEvidence();
    const model = new FakeModelProvider({ modelId: "fixture-1" });
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });

    expect(outcome.evidenceOnly).toBe(false);
    expect(outcome.degraded).toBe(false);
    expect(outcome.usage?.model).toBe("fixture-1");
    expect(model.calls).toHaveLength(1); // exactly one bounded call (ADR 0006)
    expect(model.calls[0]?.passageIds).toHaveLength(2);

    const answer = await repos.answers.get("owner-a", outcome.answerId);
    expect(answer?.evidenceOnly).toBe(false);
    expect(answer?.usage?.inputTokens).toBeGreaterThan(0);
    expect(answer?.blocks[0]?.citations[0]).toBeDefined();

    const request = await repos.requests.get("owner-a", outcome.requestId ?? "");
    expect(request?.status).toBe("completed");

    // budget: one reservation + one settlement with the model's actuals
    const ledger = await client.execute(
      "SELECT kind, state, input_tokens FROM usage_ledger WHERE owner_id = 'owner-a' ORDER BY kind",
    );
    expect(ledger.rows.map((r) => `${String(r.kind)}:${String(r.state)}`)).toEqual([
      "reservation:settled",
      "settlement:settled",
    ]);
    const settlement = ledger.rows.find((r) => String(r.kind) === "settlement");
    expect(Number(settlement?.input_tokens)).toBe(answer?.usage?.inputTokens);
  });

  it("hallucination path: invalid citations degrade to evidence-only, no repair loop", async () => {
    await seedEvidence();
    const model = new FakeModelProvider({ citationBehavior: "hallucinate" });
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });

    expect(outcome.degraded).toBe(true);
    expect(outcome.evidenceOnly).toBe(true);
    expect(outcome.usage).toBeUndefined(); // no model usage presented as the answer's

    const answer = await repos.answers.get("owner-a", outcome.answerId);
    expect(answer?.evidenceOnly).toBe(true);
    // the receipts are the passages themselves, self-cited (UUID ids)
    expect(answer?.blocks).toHaveLength(2);
    for (const block of answer?.blocks ?? []) {
      const passage = await repos.passages.get("owner-a", block.citations[0] ?? "");
      expect(passage).toBeDefined(); // every citation resolves to stored evidence
    }
    expect((await repos.requests.get("owner-a", outcome.requestId ?? ""))?.status).toBe(
      "completed",
    );
  });

  it("no-evidence path: empty evidence-only answer, zero model calls", async () => {
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: "xyzzy entirely unrelated query words",
    });
    expect(outcome).toMatchObject({ degraded: true, evidenceOnly: true });
    expect(model.calls).toHaveLength(0); // search mode discipline holds
    const answer = await repos.answers.get("owner-a", outcome.answerId);
    expect(answer?.blocks).toHaveLength(0);
  });

  it("packs passages under the input ceiling, dropping from the tail", async () => {
    await seedEvidence();
    const long =
      "bm25 weighting matters for retrieval quality and this passage repeats the term ranking many times. ".repeat(
        30,
      );
    const docId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://docs.test/long",
      originalUrl: "https://docs.test/long",
      contentHash: "hash-long-passage-0001",
      fetchedAt: "2026-09-10T00:00:00Z",
      rawText: long,
    });
    await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docId,
      excerpt: long,
      extractionStatus: "ok",
    });

    const model = new FakeModelProvider();
    await createAnswerService(makeDeps(model), { maxInputTokens: 400 }).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(model.calls[0]?.passageIds.length).toBeLessThan(3); // packed down
    expect(model.calls[0]?.passageIds.length).toBeGreaterThanOrEqual(1); // never empty
  });

  it("packing reserves the output budget from the input ceiling (ANS-02)", async () => {
    await seedEvidence();
    // Seeded prompt estimates to ~55 tokens (estimator: ceil(chars/3)).
    // Small reserve: 55 + 24 fits the 400-token ceiling → both passages go.
    const roomy = new FakeModelProvider();
    await createAnswerService(makeDeps(roomy), { maxInputTokens: 400, maxOutputTokens: 24 }).answer(
      { ownerId: "owner-a", question: QUESTION },
    );
    expect(roomy.calls[0]?.passageIds).toHaveLength(2);

    // Full ~700-class reserve: prompt + 390 exceeds 400 → packed down to the
    // floor of one passage; the reserved output budget is never eaten by
    // prompt text. Different question than the roomy run: otherwise ANS-04's
    // exact-answer cache serves run A's answer with zero model calls.
    const QUESTION_B = "how does the bm25 function rank?";
    const tight = new FakeModelProvider();
    await createAnswerService(makeDeps(tight), {
      maxInputTokens: 400,
      maxOutputTokens: 390,
    }).answer({ ownerId: "owner-a", question: QUESTION_B });
    expect(tight.calls[0]?.passageIds).toHaveLength(1);
    expect(tight.calls[0]?.maxOutputTokens).toBe(390); // ceiling passed through
  });

  it("keeps answers owner-scoped (cross-owner negative)", async () => {
    await seedEvidence("owner-a");
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-b",
      question: QUESTION,
    });
    // owner-b has no seeded evidence → no model call, evidence-only
    expect(outcome.evidenceOnly).toBe(true);
    expect(model.calls).toHaveLength(0);
    expect((await repos.answers.get("owner-a", outcome.answerId)) ?? undefined).toBeUndefined();
  });

  it("propagates provider failure after failing the request and settling zeros", async () => {
    await seedEvidence();
    const model = new FakeModelProvider({ failWith: new Error("provider down") });
    await expect(
      createAnswerService(makeDeps(model)).answer({ ownerId: "owner-a", question: QUESTION }),
    ).rejects.toThrow("provider down");
    // the request lifecycle closed as failed; no answer row exists
    const requests = await client.execute("SELECT status FROM requests WHERE owner_id = 'owner-a'");
    expect(requests.rows.map((r) => String(r.status))).toEqual(["failed"]);
    const answers = await client.execute("SELECT COUNT(*) AS n FROM answers");
    expect(Number(answers.rows[0]?.n)).toBe(0);
    // the reservation was settled with zeros rather than left open
    const ledger = await client.execute(
      "SELECT kind, state FROM usage_ledger WHERE owner_id = 'owner-a'",
    );
    expect(ledger.rows.map((r) => `${String(r.kind)}:${String(r.state)}`)).toContain(
      "reservation:settled",
    );
  });
});

describe("exact-answer cache (ANS-04, D5)", () => {
  it("serves a repeat question from the cache with zero model calls", async () => {
    await seedEvidence();
    const model = new FakeModelProvider();
    const svc = createAnswerService(makeDeps(model));

    const first = await svc.answer({ ownerId: "owner-a", question: QUESTION });
    expect(first.cached).toBe(false);
    const ledgerAfterFirst = await client.execute("SELECT COUNT(*) AS n FROM usage_ledger");

    const second = await svc.answer({
      ownerId: "owner-a",
      question: "  How does FTS5 ranking work?  ",
    });
    expect(second.cached).toBe(true);
    expect(second.answerId).toBe(first.answerId); // normalization made these the same question
    expect(model.calls).toHaveLength(1); // nothing re-ran
    const ledgerAfterSecond = await client.execute("SELECT COUNT(*) AS n FROM usage_ledger");
    expect(Number(ledgerAfterSecond.rows[0]?.n)).toBe(Number(ledgerAfterFirst.rows[0]?.n));
  });

  it("never shares a cache entry across owners", async () => {
    await seedEvidence("owner-a");
    await seedEvidence("owner-b");
    const model = new FakeModelProvider();
    const svc = createAnswerService(makeDeps(model));
    await svc.answer({ ownerId: "owner-a", question: QUESTION });
    const forB = await svc.answer({ ownerId: "owner-b", question: QUESTION });
    expect(forB.cached).toBe(false); // identical question, different owner → miss
    expect(model.calls).toHaveLength(2);
  });

  it("misses when source versions change (new evidence = new answer)", async () => {
    await seedEvidence();
    const model = new FakeModelProvider();
    const svc = createAnswerService(makeDeps(model));
    await svc.answer({ ownerId: "owner-a", question: QUESTION });

    const docId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://docs.test/fts5-v2",
      originalUrl: "https://docs.test/fts5-v2",
      contentHash: "hash-updated-source-009",
      fetchedAt: "2026-09-11T00:00:00Z",
      rawText: "updated",
    });
    await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docId,
      excerpt: "Updated bm25 documentation adds ranking details for FTS5 queries.",
      extractionStatus: "ok",
    });
    const second = await svc.answer({ ownerId: "owner-a", question: QUESTION });
    expect(second.cached).toBe(false); // source versions changed
    expect(model.calls).toHaveLength(2);
  });
});

describe("cancellation (ANS-04)", () => {
  it("refuses pre-aborted calls and closes the request as failed", async () => {
    await seedEvidence();
    const model = new FakeModelProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createAnswerService(makeDeps(model)).answer(
        { ownerId: "owner-a", question: QUESTION },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(AnswerCancelledError);
    expect(model.calls).toHaveLength(0);
    // abort fires before any booking: no request row, no ledger rows
    const requests = await client.execute("SELECT status FROM requests WHERE owner_id = 'owner-a'");
    expect(requests.rows).toHaveLength(0);
    const ledger = await client.execute("SELECT COUNT(*) AS n FROM usage_ledger");
    expect(Number(ledger.rows[0]?.n)).toBe(0);
  });
});

describe("usage reconciliation (ANS-04)", () => {
  it("reports overruns honestly when provider-reported usage exceeds the reservation", async () => {
    await seedEvidence();
    // provider reports 9000 input tokens against a 4000 reservation
    const model = new FakeModelProvider({
      usage: { inputTokens: 9000, outputTokens: 100 },
    });
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.reconciliation).toMatchObject({
      overrun: true,
      deltaInput: 5000,
      deltaOutput: -600, // 100 actual vs 700 reserved: under, not an overrun
    });
    // the answer still stored the provider-reported usage
    const answer = await repos.answers.get("owner-a", outcome.answerId);
    expect(answer?.usage?.inputTokens).toBe(9000);
    expect(answer?.usage?.estimated).toBe(false);
  });

  it("reports no overrun when actuals fit the reservation", async () => {
    await seedEvidence();
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.reconciliation?.overrun).toBe(false);
  });
});

describe("answer service (RET-02 hybrid retrieval)", () => {
  it("surfaces a paraphrase passage when an embedder is provided", async () => {
    await seedEvidence();
    const paraphrase = "Saturation effects cap the benefit of repeating words in scored text.";
    const docId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://docs.test/paraphrase",
      originalUrl: "https://docs.test/paraphrase",
      contentHash: "hash-paraphrase-00001",
      fetchedAt: "2026-09-13T00:00:00Z",
      rawText: paraphrase,
    });
    const paraphraseId = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: docId,
      excerpt: paraphrase,
      extractionStatus: "ok",
    });
    // Question vector [1,0]; the paraphrase passage is semantically closest
    // while sharing no query tokens with "how does fts5 ranking work?".
    const vectors: Record<string, number[]> = {
      [QUESTION]: [1, 0],
      "FTS5 ranks keyword matches with bm25, where lower scores are better.": [0.6, 0.4],
      "The bm25 function weighs rarer terms more heavily in the ranking.": [0.55, 0.45],
      [paraphrase]: [0.99, 0.01],
    };
    const embedder: TextEmbedder = {
      modelId: "fake-embed-1",
      async embedPassages(texts) {
        return texts.map((t) => vectors[t] ?? [0, 0, 1]);
      },
      async embedQuery(text) {
        return vectors[text] ?? [0, 0, 1];
      },
    };
    await backfillPassageEmbeddings(client, "owner-a", embedder);

    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model, true, embedder)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.evidenceOnly).toBe(false);
    expect(outcome.degraded).toBe(false);
    const packedIds = model.calls[0]?.passageIds ?? [];
    expect(packedIds).toContain(paraphraseId); // the vector list contributed it
  });

  it("stays on plain bm25 when no embedder is provided", async () => {
    await seedEvidence();
    const model = new FakeModelProvider();
    const outcome = await createAnswerService(makeDeps(model)).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.evidenceOnly).toBe(false);
    expect(model.calls[0]?.passageIds).toHaveLength(2); // seeded passages only
  });
});

describe("answer evidence basis (ANS-07, R-15/F9)", () => {
  it("reports 'run' when the evidence came from a completed research run for this question", async () => {
    const reqId = await repos.requests.create("owner-a", "search", QUESTION);
    await seedEvidence("owner-a", reqId);
    await repos.requests.complete("owner-a", reqId);
    const outcome = await createAnswerService(makeDeps(new FakeModelProvider())).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.evidenceFromRun).toBe("run");
  });

  it("reports 'cross-question' when the only evidence belongs to another question's run (F9)", async () => {
    const reqId = await repos.requests.create("owner-a", "search", "totally unrelated question?");
    await seedEvidence("owner-a", reqId);
    await repos.requests.complete("owner-a", reqId);
    const outcome = await createAnswerService(makeDeps(new FakeModelProvider())).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    // The research run for THIS question stored nothing; the answer drew on
    // leftovers — the outcome must say so instead of claiming grounded work.
    expect(outcome.evidenceFromRun).toBe("cross-question");
  });

  it("reports 'legacy' for evidence with no run linkage", async () => {
    await seedEvidence("owner-a"); // pre-ANS-07 document: NULL request_id
    const outcome = await createAnswerService(makeDeps(new FakeModelProvider())).answer({
      ownerId: "owner-a",
      question: QUESTION,
    });
    expect(outcome.evidenceFromRun).toBe("legacy");
  });

  it("a cache hit returns the stored basis without recomputing", async () => {
    const reqId = await repos.requests.create("owner-a", "search", QUESTION);
    await seedEvidence("owner-a", reqId);
    await repos.requests.complete("owner-a", reqId);
    const service = createAnswerService(makeDeps(new FakeModelProvider()));
    const first = await service.answer({ ownerId: "owner-a", question: QUESTION });
    expect(first.evidenceFromRun).toBe("run");
    const second = await service.answer({
      ownerId: "owner-a",
      question: `  ${QUESTION.toUpperCase()}  `, // whitespace/case-normalized
    });
    expect(second.cached).toBe(true);
    expect(second.evidenceFromRun).toBe("run");
  });
});
