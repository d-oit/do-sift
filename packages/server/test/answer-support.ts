/** Shared in-memory fixture for the answer service tests (ANS-03/ANS-04): seeded evidence, budgets, and deps. */
import { createClient, type Client } from "@libsql/client";
import { beforeEach } from "vitest";
import { type FakeModelProvider } from "@do-sift/fake-providers";
import {
  BudgetService,
  Repositories,
  applyMigrations,
  loadMigrations,
  type TextEmbedder,
} from "@do-sift/storage";
import { type AnswerServiceDeps } from "../src/index.js";
export const QUESTION = "how does fts5 ranking work?";
export let client: Client;
export let repos: Repositories;
export let budgets: BudgetService;
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
export async function seedEvidence(
  ownerId = "owner-a",
  requestId?: string,
  relevanceScore?: number,
): Promise<void> {
  const docInit: Parameters<typeof repos.documents.insert>[0] = {
    ownerId,
    canonicalUrl: "https://docs.test/fts5",
    originalUrl: "https://docs.test/fts5",
    contentHash: "hash-fts5-ranking-0001",
    fetchedAt: "2026-09-10T00:00:00Z",
    rawText: "FTS5 ranking",
  };
  if (requestId !== undefined) docInit.requestId = requestId;
  if (relevanceScore !== undefined) docInit.relevanceScore = relevanceScore;
  const docId = await repos.documents.insert(docInit);
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
export function makeDeps(
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
