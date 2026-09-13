/**
 * Consolidated budget-bypass negatives (CORE-10): attempts to spend or
 * reserve around the ledger through the answer service and the budget
 * service directly. Per-layer suites (budget.test.ts in packages/storage)
 * prove the arithmetic; these prove the bypass attempts fail.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeModelProvider } from "@do-sift/fake-providers";
import {
  BudgetService,
  BudgetServiceError,
  Repositories,
  applyMigrations,
  loadMigrations,
} from "@do-sift/storage";
import { createAnswerService } from "@do-sift/server";

const REQUEST = {
  maxInputTokens: 4000,
  maxOutputTokens: 700,
  maxSearchCalls: 0,
  maxFetches: 0,
  deadlineMs: 30_000,
} as const;

const T0 = Date.parse("2026-09-11T12:00:00.000Z");

let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  for (const id of ["owner-a", "owner-b"]) {
    await repos.owners.ensure(id, id);
  }
  const docId = await repos.documents.insert({
    ownerId: "owner-a",
    canonicalUrl: "https://docs.test/ranking",
    originalUrl: "https://docs.test/ranking",
    contentHash: "hash-ranking-00000001",
    fetchedAt: "2026-09-11T00:00:00Z",
    rawText: "ranking",
  });
  await repos.passages.insert({
    ownerId: "owner-a",
    documentId: docId,
    excerpt: "bm25 ranks keyword matches with rarer terms weighing more in the score.",
    extractionStatus: "ok",
  });
});

describe("budget bypass attempts (CORE-10)", () => {
  it("repeated answers drain the daily cap and the model stops being called", async () => {
    const budgets = new BudgetService(client, {
      maxInputTokens: 8_000, // fits ~2 reservations of 4000
      maxOutputTokens: 10_000,
      maxSearchCalls: 100,
      maxFetches: 100,
    });
    const model = new FakeModelProvider({ usage: { inputTokens: 4_500, outputTokens: 100 } });
    const svc = createAnswerService({ client, repositories: repos, model, budget: budgets });

    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(
        await svc
          .answer({ ownerId: "owner-a", question: `question number ${i} about bm25 ranking` })
          .catch((e: unknown) => e),
      );
    }
    // answer 1 settles 4500 actual input; 4500 held + 4000 reserve > 8000 cap
    expect(outcomes[0]).not.toBeInstanceOf(Error);
    expect(outcomes[1]).toBeInstanceOf(BudgetServiceError);
    expect(outcomes[1]).toMatchObject({ kind: "cap-exceeded" });
    expect(outcomes[2]).toBeInstanceOf(BudgetServiceError);
    // capped answers never reached the model
    expect(model.calls).toHaveLength(1);
    // and the ledger holds no open reservations afterwards (all settled)
    const open = await client.execute(
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE owner_id = 'owner-a' AND state = 'open'",
    );
    expect(Number(open.rows[0]?.n)).toBe(0);
  });

  it("concurrent over-cap reservations leave exactly one open (no double-book)", async () => {
    const budgets = new BudgetService(client, {
      maxInputTokens: 4_000,
      maxOutputTokens: 10_000,
      maxSearchCalls: 100,
      maxFetches: 100,
    });
    const results = await Promise.allSettled([
      budgets.reserve({ ownerId: "owner-a", request: REQUEST, estimatedInputTokens: 1, nowMs: T0 }),
      budgets.reserve({ ownerId: "owner-a", request: REQUEST, estimatedInputTokens: 1, nowMs: T0 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const open = await client.execute(
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE owner_id = 'owner-a' AND state = 'open'",
    );
    expect(Number(open.rows[0]?.n)).toBe(1);
  });

  it("expired reservations cannot be settled to free retroactive budget", async () => {
    const budgets = new BudgetService(client, {
      maxInputTokens: 4_000,
      maxOutputTokens: 10_000,
      maxSearchCalls: 100,
      maxFetches: 100,
    });
    const { id } = await budgets.reserve({
      ownerId: "owner-a",
      request: { ...REQUEST, deadlineMs: 10 },
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    await budgets.expireDue("owner-a", T0 + 11);
    await expect(
      budgets.settle({
        ownerId: "owner-a",
        reservationId: id,
        actual: { inputTokens: 4_000, outputTokens: 700 },
        nowMs: T0 + 12,
      }),
    ).rejects.toBeInstanceOf(BudgetServiceError);
  });

  it("cross-owner settle is refused with no existence leak", async () => {
    const budgets = new BudgetService(client, {
      maxInputTokens: 40_000,
      maxOutputTokens: 10_000,
      maxSearchCalls: 100,
      maxFetches: 100,
    });
    const { id } = await budgets.reserve({
      ownerId: "owner-a",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    await expect(
      budgets.settle({
        ownerId: "owner-b",
        reservationId: id,
        actual: { inputTokens: 0, outputTokens: 0 },
        nowMs: T0 + 1,
      }),
    ).rejects.toMatchObject({ kind: "unknown-reservation" });
    // the reservation is untouched and still usable by its real owner
    await expect(
      budgets.settle({
        ownerId: "owner-a",
        reservationId: id,
        actual: { inputTokens: 10, outputTokens: 5 },
        nowMs: T0 + 2,
      }),
    ).resolves.toMatchObject({ overrun: false });
  });

  it("provider-reported overruns are recorded, never clipped or hidden", async () => {
    const budgets = new BudgetService(client, {
      maxInputTokens: 40_000,
      maxOutputTokens: 10_000,
      maxSearchCalls: 100,
      maxFetches: 100,
    });
    const model = new FakeModelProvider({ usage: { inputTokens: 9_000, outputTokens: 700 } });
    const outcome = await createAnswerService({
      client,
      repositories: repos,
      model,
      budget: budgets,
    }).answer({ ownerId: "owner-a", question: "bm25 ranking explained" });
    expect(outcome.reconciliation?.overrun).toBe(true);
    const settled = await client.execute(
      "SELECT input_tokens FROM usage_ledger WHERE kind = 'settlement' AND owner_id = 'owner-a'",
    );
    expect(Number(settled.rows[0]?.input_tokens)).toBe(9_000); // honest ledger
  });
});
