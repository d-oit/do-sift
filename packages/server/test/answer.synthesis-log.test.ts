/**
 * Synthesis call logging (issue #123, plan 038 — EXT-03).
 *
 * The ledger records tokens against a daily cap; it does not record WHICH
 * provider/model ran or what the call cost at which price. This suite pins the
 * audit trail: one row per attempt, written from the runtime's own tenant
 * binding, with the price the router verified — and never at the cost of losing
 * a produced answer.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeModelProvider } from "@do-sift/fake-providers";
import { createAnswerService } from "../src/answer.js";
import type { SynthesisAuditEvent } from "../src/answer-contracts.js";
import {
  Repositories,
  SynthesisCallLogService,
  applyMigrations,
  loadMigrations,
  synthesisCostMicroUsd,
} from "@do-sift/storage";

const OWNER = "owner-log";
const QUESTION = "how does bm25 rank matches?";

let client: Client;
let repositories: Repositories;

async function seedEvidence(): Promise<void> {
  const documentId = await repositories.documents.insert({
    ownerId: OWNER,
    canonicalUrl: "https://log.test/bm25",
    originalUrl: "https://log.test/bm25",
    contentHash: "hash-bm25-log",
    fetchedAt: "2026-11-03T00:00:00Z",
    rawText: "bm25 ranks matches by term frequency and document length.",
  });
  await repositories.passages.insert({
    ownerId: OWNER,
    documentId,
    excerpt: "BM25 ranks matches by term frequency and inverse document frequency.",
    extractionStatus: "ok",
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repositories = new Repositories(client);
  await repositories.owners.ensure(OWNER, "Log owner");
  await seedEvidence();
});

describe("SynthesisCallLogService", () => {
  it("records a completed call with the computed cost", async () => {
    const log = new SynthesisCallLogService(client);
    const id = await log.record({
      tenantId: "default",
      ownerId: OWNER,
      provider: "openai-compat",
      model: "test-model",
      estimated: false,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      priceInputPer1mMicroUsd: 3_000_000,
      priceOutputPer1mMicroUsd: 15_000_000,
      outcome: "completed",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);

    const rows = await log.list(OWNER);
    expect(rows).toHaveLength(1);
    // 1M input × $3 = $3 = 3,000,000 µUSD; 1M output × $15 = 15,000,000 µUSD.
    expect(rows[0]?.totalCostMicroUsd).toBe(18_000_000);
    expect(rows[0]?.estimated).toBe(false);
    expect(rows[0]?.outcome).toBe("completed");
  });

  it("rounds cost up so a stored cost never understates the price", () => {
    // 1 token at $3/1M = 0.000003 USD = 3 µUSD exactly.
    expect(synthesisCostMicroUsd(1, 0, 3_000_000, 0).totalCostMicroUsd).toBe(3);
    // 1 token at $0.15/1M = 0.15 µUSD → 1 (never 0).
    expect(synthesisCostMicroUsd(1, 0, 150_000, 0).totalCostMicroUsd).toBe(1);
    expect(synthesisCostMicroUsd(0, 0, 3_000_000, 15_000_000).totalCostMicroUsd).toBe(0);
  });

  it("records a failed call with zero cost and its failure kind", async () => {
    const log = new SynthesisCallLogService(client);
    await log.record({
      tenantId: "default",
      ownerId: OWNER,
      provider: "openai-compat",
      model: "test-model",
      estimated: true,
      inputTokens: 0,
      outputTokens: 0,
      priceInputPer1mMicroUsd: 3_000_000,
      priceOutputPer1mMicroUsd: 15_000_000,
      outcome: "failed",
      failureKind: "rate-limited",
    });
    const rows = await log.list(OWNER);
    expect(rows[0]?.outcome).toBe("failed");
    expect(rows[0]?.failureKind).toBe("rate-limited");
    expect(rows[0]?.totalCostMicroUsd).toBe(0);
  });

  it("does not leak another tenant's or owner's calls", async () => {
    const other = new Repositories(client, "other-tenant");
    await other.owners.ensure("owner-other", "Other");
    await new SynthesisCallLogService(client, "other-tenant").record({
      tenantId: "other-tenant",
      ownerId: "owner-other",
      provider: "p",
      model: "m",
      estimated: true,
      inputTokens: 10,
      outputTokens: 5,
      priceInputPer1mMicroUsd: 0,
      priceOutputPer1mMicroUsd: 0,
      outcome: "completed",
    });
    const mine = new SynthesisCallLogService(client);
    await mine.record({
      tenantId: "default",
      ownerId: OWNER,
      provider: "p2",
      model: "m2",
      estimated: true,
      inputTokens: 1,
      outputTokens: 1,
      priceInputPer1mMicroUsd: 0,
      priceOutputPer1mMicroUsd: 0,
      outcome: "completed",
    });

    expect((await mine.list(OWNER)).map((r) => r.model)).toEqual(["m2"]);
    expect(await mine.list("owner-other")).toEqual([]);
  });

  it("totals a day per owner and ignores other days", async () => {
    const log = new SynthesisCallLogService(client);
    const base = {
      tenantId: "default",
      ownerId: OWNER,
      provider: "p",
      model: "m",
      estimated: false,
      inputTokens: 1_000_000,
      outputTokens: 0,
      priceInputPer1mMicroUsd: 1_000_000,
      priceOutputPer1mMicroUsd: 0,
      outcome: "completed" as const,
    };
    await log.record({ ...base, at: "2026-11-03T01:00:00.000Z" });
    await log.record({ ...base, at: "2026-11-03T23:00:00.000Z" });
    await log.record({ ...base, at: "2026-11-04T01:00:00.000Z" });
    expect(await log.totalCostMicroUsdForDay(OWNER, "2026-11-03")).toBe(2_000_000);
    expect(await log.totalCostMicroUsdForDay(OWNER, "2026-11-04")).toBe(1_000_000);
  });

  it("rejects a malformed record instead of storing a half-truth", async () => {
    const log = new SynthesisCallLogService(client);
    const valid = {
      tenantId: "default",
      ownerId: OWNER,
      provider: "p",
      model: "m",
      estimated: false,
      inputTokens: 1,
      outputTokens: 1,
      priceInputPer1mMicroUsd: 0,
      priceOutputPer1mMicroUsd: 0,
      outcome: "completed" as const,
    };
    await expect(log.record({ ...valid, ownerId: "  " })).rejects.toThrow(/owner id/u);
    await expect(log.record({ ...valid, provider: "" })).rejects.toThrow(/provider/u);
    await expect(log.record({ ...valid, inputTokens: -1 })).rejects.toThrow(/negative/u);
    expect(() => new SynthesisCallLogService(client, " ")).toThrow(/non-empty tenant/u);
  });
});

describe("AnswerServiceDeps.onSynthesis", () => {
  it("reports the completed call with the answer and request ids", async () => {
    const events: SynthesisAuditEvent[] = [];
    const service = createAnswerService({
      client,
      repositories,
      model: new FakeModelProvider({ modelId: "fake-model" }),
      onSynthesis: (event) => {
        events.push(event);
      },
    });

    const outcome = await service.answer({ ownerId: OWNER, question: QUESTION });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.outcome).toBe("completed");
    expect(event.ownerId).toBe(OWNER);
    expect(event.tenantId).toBe("default");
    expect(event.provider).toBe("fake-model");
    expect(event.model).toBe("fake-model");
    expect(event.answerId).toBe(outcome.answerId);
    expect(event.requestId).toBe(outcome.requestId);
    expect(event.inputTokens).toBeGreaterThan(0);
  });

  it("reports a failed call even though the answer degrades to evidence-only", async () => {
    const events: SynthesisAuditEvent[] = [];
    const service = createAnswerService({
      client,
      repositories,
      model: {
        name: "flaky",
        modelId: "flaky-model",
        complete: async () => {
          throw Object.assign(new Error("upstream said no"), { kind: "rate-limited" });
        },
      },
      onSynthesis: (event) => {
        events.push(event);
      },
    });

    const outcome = await service.answer({ ownerId: OWNER, question: QUESTION });
    expect(outcome.evidenceOnly).toBe(true);
    expect(outcome.degradationReason).toBe("model-failed");
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("failed");
    expect(events[0]?.failureKind).toBe("rate-limited");
    expect(events[0]?.inputTokens).toBe(0);
  });

  it("does not lose the answer when the audit hook throws", async () => {
    const service = createAnswerService({
      client,
      repositories,
      model: new FakeModelProvider(),
      onSynthesis: () => {
        throw new Error("audit store is down");
      },
    });
    const outcome = await service.answer({ ownerId: OWNER, question: QUESTION });
    expect(outcome.answerId).toBeTruthy();
    expect(outcome.degraded).toBe(false);
    expect(
      (await repositories.answers.get(OWNER, outcome.answerId))?.blocks.length,
    ).toBeGreaterThan(0);
  });

  it("does not report a call when no evidence was retrieved (nothing was called)", async () => {
    const events: SynthesisAuditEvent[] = [];
    const service = createAnswerService({
      client,
      repositories,
      model: new FakeModelProvider(),
      onSynthesis: (event) => {
        events.push(event);
      },
    });
    const outcome = await service.answer({
      ownerId: OWNER,
      question: "completely unrelated question about penguins",
    });
    expect(outcome.evidenceOnly).toBe(true);
    expect(events).toEqual([]);
  });
});
