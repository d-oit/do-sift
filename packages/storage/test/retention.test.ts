import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ScheduledRetentionRunner,
  applyMigrations,
  calculateRetentionCutoff,
  evaluateOwnerRetention,
  getStartOfUtcDay,
  loadMigrations,
  pruneOwnerHistory,
  validateRetentionCutoff,
} from "../src/index.js";

let client: Client;

const OLD = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2026-06-01T00:00:00.000Z";
const NOW = new Date("2026-08-01T12:00:00.000Z");

async function insertJob(id: string, ownerId: string, status: string, updatedAt: string) {
  await client.execute({
    sql: `INSERT INTO jobs (id, owner_id, kind, payload_json, status, attempts, created_at, updated_at)
          VALUES (?, ?, 'k', '{}', ?, 0, ?, ?)`,
    args: [id, ownerId, status, updatedAt, updatedAt],
  });
}

async function insertUsage(id: string, ownerId: string, state: string, createdAt: string) {
  await client.execute({
    sql: `INSERT INTO usage_ledger (id, owner_id, kind, day, state, created_at)
          VALUES (?, ?, 'reservation', '2026-01-01', ?, ?)`,
    args: [id, ownerId, state, createdAt],
  });
}

async function insertDocument(id: string, ownerId: string) {
  await client.execute({
    sql: `INSERT INTO documents (id, owner_id, canonical_url, original_url, content_hash, title, raw_text, fetched_at, created_at)
          VALUES (?, ?, ?, ?, 'hash', 'title', 'text', ?, ?)`,
    args: [id, ownerId, `https://example.com/${id}`, `https://example.com/${id}`, OLD, OLD],
  });
}

async function ids(table: "jobs" | "usage_ledger" | "documents"): Promise<string[]> {
  const res = await client.execute(`SELECT id FROM ${table} ORDER BY id`);
  return res.rows.map((r) => String(r.id));
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  for (const id of ["ret-owner", "ret-other"]) {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, ?)",
      args: [id, id, OLD],
    });
  }
});

describe("retention cutoffs and validation", () => {
  it("calculates retention cutoff at start of UTC day minus N days", () => {
    const now = new Date("2026-08-15T15:30:00.000Z");
    const startOfToday = getStartOfUtcDay(now);
    expect(startOfToday.toISOString()).toBe("2026-08-15T00:00:00.000Z");

    const cutoff30 = calculateRetentionCutoff(30, now);
    expect(cutoff30).toBe("2026-07-16T00:00:00.000Z");
  });

  it("throws on invalid retentionDays for calculateRetentionCutoff", () => {
    expect(() => calculateRetentionCutoff(0)).toThrow(/retentionDays must be an integer >= 1/);
    expect(() => calculateRetentionCutoff(-5)).toThrow(/retentionDays must be an integer >= 1/);
  });

  it("validates cutoff is a valid ISO date at or before current UTC day start", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    expect(() => validateRetentionCutoff("not-a-date", now)).toThrow(/valid ISO timestamp/);

    const futureCutoff = "2026-08-16T00:00:00.000Z";
    expect(() => validateRetentionCutoff(futureCutoff, now)).toThrow(
      /must be at or before start of current UTC day/,
    );

    const validCutoff = "2026-08-15T00:00:00.000Z";
    expect(() => validateRetentionCutoff(validCutoff, now)).not.toThrow();
  });
});

describe("pruneOwnerHistory (#64)", () => {
  it("evaluates candidates in dry run without deleting rows", async () => {
    await insertJob("j-old-done", "ret-owner", "done", OLD);
    await insertJob("j-old-dead", "ret-owner", "dead", OLD);
    await insertUsage("u-old-settled", "ret-owner", "settled", OLD);

    const candidates = await evaluateOwnerRetention(client, "ret-owner", CUTOFF, NOW);
    expect(candidates).toEqual({ jobsCandidateCount: 2, usageCandidateCount: 1 });

    const receipt = await pruneOwnerHistory(client, "ret-owner", CUTOFF, {
      dryRun: true,
      now: NOW,
    });
    expect(receipt).toMatchObject({
      ownerId: "ret-owner",
      cutoffIso: CUTOFF,
      dryRun: true,
      jobsCandidateCount: 2,
      jobsDeletedCount: 0,
      usageCandidateCount: 1,
      usageDeletedCount: 0,
      success: true,
    });

    expect((await ids("jobs")).length).toBe(2);
    expect((await ids("usage_ledger")).length).toBe(1);
  });

  it("deletes only old terminal jobs and closed usage for the given owner", async () => {
    await insertJob("j-old-done", "ret-owner", "done", OLD);
    await insertJob("j-old-dead", "ret-owner", "dead", OLD);
    await insertJob("j-old-queued", "ret-owner", "queued", OLD);
    await insertJob("j-old-leased", "ret-owner", "leased", OLD);
    await insertJob("j-new-done", "ret-owner", "done", "2026-07-01T00:00:00.000Z");
    await insertJob("j-other-done", "ret-other", "done", OLD);
    await insertUsage("u-old-settled", "ret-owner", "settled", OLD);
    await insertUsage("u-old-expired", "ret-owner", "expired", OLD);
    await insertUsage("u-old-open", "ret-owner", "open", OLD);
    await insertUsage("u-new-settled", "ret-owner", "settled", "2026-07-01T00:00:00.000Z");
    await insertUsage("u-other-settled", "ret-other", "settled", OLD);
    await insertDocument("doc-1", "ret-owner");

    const receipt = await pruneOwnerHistory(client, "ret-owner", CUTOFF, {
      dryRun: false,
      now: NOW,
    });

    expect(receipt).toMatchObject({
      ownerId: "ret-owner",
      cutoffIso: CUTOFF,
      dryRun: false,
      jobsCandidateCount: 2,
      jobsDeletedCount: 2,
      usageCandidateCount: 2,
      usageDeletedCount: 2,
      success: true,
    });

    expect(await ids("jobs")).toEqual(
      ["j-new-done", "j-old-leased", "j-old-queued", "j-other-done"].sort(),
    );
    expect(await ids("usage_ledger")).toEqual(
      ["u-new-settled", "u-old-open", "u-other-settled"].sort(),
    );
    expect(await ids("documents")).toEqual(["doc-1"]);
  });

  it("is idempotent on repeated execution", async () => {
    await insertJob("j-old-done", "ret-owner", "done", OLD);
    await insertUsage("u-old-settled", "ret-owner", "settled", OLD);

    const first = await pruneOwnerHistory(client, "ret-owner", CUTOFF, { dryRun: false, now: NOW });
    expect(first.jobsDeletedCount).toBe(1);
    expect(first.usageDeletedCount).toBe(1);

    const second = await pruneOwnerHistory(client, "ret-owner", CUTOFF, {
      dryRun: false,
      now: NOW,
    });
    expect(second.jobsCandidateCount).toBe(0);
    expect(second.jobsDeletedCount).toBe(0);
    expect(second.usageCandidateCount).toBe(0);
    expect(second.usageDeletedCount).toBe(0);
  });
});

describe("ScheduledRetentionRunner", () => {
  it("runs retention pruning across owners when triggered", async () => {
    await insertJob("j-1", "ret-owner", "done", OLD);
    await insertJob("j-2", "ret-other", "done", OLD);

    const receipts: unknown[] = [];
    const runner = new ScheduledRetentionRunner({
      client,
      owners: ["ret-owner", "ret-other"],
      retentionDays: 30,
      intervalMs: 86400000,
      now: () => NOW,
      onReceipt: (r) => receipts.push(r),
    });

    const res = await runner.runOnce();
    expect(res.length).toBe(2);
    expect(receipts.length).toBe(2);
    expect((await ids("jobs")).length).toBe(0);
  });
});
