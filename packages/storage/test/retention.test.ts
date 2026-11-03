import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMBER_CHANGE_RETENTION_DAYS,
  applyMigrations,
  calculateSafeCutoff,
  calculateStartOfTodayUtc,
  executeOwnerRetention,
  loadMigrations,
  pruneMemberChangeLog,
  pruneOwnerHistory,
  validateCutoffIso,
} from "../src/index.js";

let client: Client;

const OLD = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2026-06-01T00:00:00.000Z";
const FIXED_NOW = new Date("2026-07-01T12:00:00.000Z");

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

async function insertEvidence(id: string, ownerId: string, createdAt: string) {
  await client.execute({
    sql: `INSERT INTO documents (id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, created_at)
          VALUES (?, ?, 'https://example.com/' || ?, 'https://example.com/' || ?, 'h_' || ?, ?, 'Title', ?)`,
    args: [id, ownerId, id, id, id, createdAt, createdAt],
  });
  await client.execute({
    sql: `INSERT INTO passages (id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
          VALUES ('p_' || ?, ?, ?, 'Heading', 'Excerpt text', 'ok', ?)`,
    args: [id, ownerId, id, createdAt],
  });
}

async function ids(table: "jobs" | "usage_ledger" | "documents" | "passages"): Promise<string[]> {
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

describe("calculateStartOfTodayUtc and calculateSafeCutoff", () => {
  it("calculates start of today UTC correctly", () => {
    const d = new Date("2026-05-15T23:59:59.999Z");
    expect(calculateStartOfTodayUtc(d).toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("calculates safe cutoffs strictly before today UTC", () => {
    const cutoff = calculateSafeCutoff(30, FIXED_NOW);
    expect(cutoff).toBe("2026-06-01T00:00:00.000Z");
  });

  it("rejects non-positive integer retention days", () => {
    expect(() => calculateSafeCutoff(0, FIXED_NOW)).toThrow(/positive integer/);
    expect(() => calculateSafeCutoff(-5, FIXED_NOW)).toThrow(/positive integer/);
    expect(() => calculateSafeCutoff(1.5, FIXED_NOW)).toThrow(/positive integer/);
  });

  it("validates cutoff ISO and rejects cutoffs crossing into current UTC day", () => {
    // Valid past cutoff
    expect(validateCutoffIso("2026-06-30T00:00:00.000Z", FIXED_NOW)).toBe(
      "2026-06-30T00:00:00.000Z",
    );
    // Equal to start of today UTC is valid
    expect(validateCutoffIso("2026-07-01T00:00:00.000Z", FIXED_NOW)).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    // Crossing into current UTC day is rejected
    expect(() => validateCutoffIso("2026-07-01T00:00:01.000Z", FIXED_NOW)).toThrow(
      /cannot cross into current UTC day/,
    );
    // Future date is rejected
    expect(() => validateCutoffIso("2026-07-02T00:00:00.000Z", FIXED_NOW)).toThrow(
      /cannot cross into current UTC day/,
    );
    // Malformed date
    expect(() => validateCutoffIso("invalid-date", FIXED_NOW)).toThrow(/not a valid ISO timestamp/);
  });
});

describe("membership change log retention (plan 024, MT-11)", () => {
  const TENANT = "acme";
  const OTHER_TENANT = "globex";

  async function seedTenants() {
    for (const [id, name] of [
      [TENANT, "Acme"],
      [OTHER_TENANT, "Globex"],
    ] as const) {
      await client.execute({
        sql: "INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)",
        args: [id, name, OLD],
      });
    }
  }

  async function insertChange(tenantId: string, target: string, createdAt: string) {
    await client.execute({
      sql: "INSERT INTO tenant_member_changes (tenant_id, actor_user_id, target_user_id, action, from_role, to_role, created_at) VALUES (?, 'owner-1', ?, 'added', NULL, 'member', ?)",
      args: [tenantId, target, createdAt],
    });
  }

  async function targets(): Promise<string[]> {
    const res = await client.execute(
      "SELECT target_user_id FROM tenant_member_changes ORDER BY id",
    );
    return res.rows.map((row) => String(row.target_user_id));
  }

  it("prunes one tenant's old changes and nothing else", async () => {
    await seedTenants();
    await insertChange(TENANT, "old-1", "2026-01-01T00:00:00.000Z");
    await insertChange(TENANT, "old-2", "2026-01-02T00:00:00.000Z");
    await insertChange(TENANT, "new", "2026-06-15T00:00:00.000Z");
    await insertChange(OTHER_TENANT, "old-other", "2026-01-01T00:00:00.000Z");

    const receipt = await pruneMemberChangeLog(client, {
      tenantId: TENANT,
      beforeIso: CUTOFF,
      now: FIXED_NOW,
    });

    expect(receipt).toMatchObject({
      tenantId: TENANT,
      cutoff: CUTOFF,
      dryRun: false,
      candidates: 2,
      deleted: 2,
      success: true,
    });
    expect(await targets()).toEqual(["new", "old-other"]);
  });

  it("reports candidates in dry-run mode without deleting", async () => {
    await seedTenants();
    await insertChange(TENANT, "old", "2026-01-01T00:00:00.000Z");
    await insertChange(TENANT, "new", "2026-06-20T00:00:00.000Z");

    const receipt = await pruneMemberChangeLog(client, {
      tenantId: TENANT,
      retentionDays: 30,
      dryRun: true,
      now: FIXED_NOW,
    });

    expect(receipt).toMatchObject({ dryRun: true, candidates: 1, deleted: 0, success: true });
    expect(await targets()).toEqual(["old", "new"]);
  });

  it("refuses to shorten the review window below the floor", async () => {
    await seedTenants();
    await insertChange(TENANT, "old", "2026-01-01T00:00:00.000Z");

    await expect(
      pruneMemberChangeLog(client, { tenantId: TENANT, retentionDays: 7, now: FIXED_NOW }),
    ).rejects.toThrow(/at least 30 days/);
    await expect(
      pruneMemberChangeLog(client, {
        tenantId: TENANT,
        beforeIso: calculateSafeCutoff(7, FIXED_NOW),
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(/30-day floor/);
    expect(DEFAULT_MEMBER_CHANGE_RETENTION_DAYS).toBe(365);
    expect(await targets()).toEqual(["old"]);
  });

  it("requires a tenant and an explicit window", async () => {
    await expect(
      pruneMemberChangeLog(client, { tenantId: " ", retentionDays: 30, now: FIXED_NOW }),
    ).rejects.toThrow(/tenantId is required/);
    await expect(
      pruneMemberChangeLog(client, { tenantId: TENANT, now: FIXED_NOW }),
    ).rejects.toThrow(/either beforeIso or retentionDays/);
  });

  it("is idempotent and leaves a year of history alone by default", async () => {
    await seedTenants();
    await insertChange(TENANT, "recent", "2026-01-01T00:00:00.000Z");
    await insertChange(TENANT, "old", "2025-01-01T00:00:00.000Z");

    const yearly = await pruneMemberChangeLog(client, {
      tenantId: TENANT,
      retentionDays: DEFAULT_MEMBER_CHANGE_RETENTION_DAYS,
      now: FIXED_NOW,
    });
    expect(yearly).toMatchObject({ candidates: 1, deleted: 1 });
    expect(await targets()).toEqual(["recent"]);

    const again = await pruneMemberChangeLog(client, {
      tenantId: TENANT,
      beforeIso: CUTOFF,
      now: FIXED_NOW,
    });
    expect(again).toMatchObject({ candidates: 1, deleted: 1, success: true });
    expect(await targets()).toEqual([]);

    const repeat = await pruneMemberChangeLog(client, {
      tenantId: TENANT,
      beforeIso: CUTOFF,
      now: FIXED_NOW,
    });
    expect(repeat).toMatchObject({ candidates: 0, deleted: 0, success: true });
  });
});

describe("executeOwnerRetention (#64)", () => {
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

    await insertEvidence("doc-1", "ret-owner", OLD);
    await insertEvidence("doc-2", "ret-other", OLD);

    const receipt = await executeOwnerRetention(client, {
      ownerId: "ret-owner",
      beforeIso: CUTOFF,
      dryRun: false,
      now: FIXED_NOW,
    });

    expect(receipt.success).toBe(true);
    expect(receipt.dryRun).toBe(false);
    expect(receipt.candidates).toEqual({ terminalJobs: 2, closedUsage: 2 });
    expect(receipt.deleted).toEqual({ terminalJobs: 2, closedUsage: 2 });

    expect(await ids("jobs")).toEqual(
      ["j-new-done", "j-old-leased", "j-old-queued", "j-other-done"].sort(),
    );
    expect(await ids("usage_ledger")).toEqual(
      ["u-new-settled", "u-old-open", "u-other-settled"].sort(),
    );
    // Evidence is completely preserved
    expect(await ids("documents")).toEqual(["doc-1", "doc-2"]);
    expect(await ids("passages")).toEqual(["p_doc-1", "p_doc-2"]);
  });

  it("performs dry-run without deleting rows", async () => {
    await insertJob("j-old-done", "ret-owner", "done", OLD);
    await insertUsage("u-old-settled", "ret-owner", "settled", OLD);

    const receipt = await executeOwnerRetention(client, {
      ownerId: "ret-owner",
      retentionDays: 30,
      dryRun: true,
      now: FIXED_NOW,
    });

    expect(receipt.success).toBe(true);
    expect(receipt.dryRun).toBe(true);
    expect(receipt.candidates).toEqual({ terminalJobs: 1, closedUsage: 1 });
    expect(receipt.deleted).toEqual({ terminalJobs: 0, closedUsage: 0 });

    // Rows still exist
    expect(await ids("jobs")).toEqual(["j-old-done"]);
    expect(await ids("usage_ledger")).toEqual(["u-old-settled"]);
  });

  it("is idempotent across repeated executions", async () => {
    await insertJob("j-old-done", "ret-owner", "done", OLD);
    await insertUsage("u-old-settled", "ret-owner", "settled", OLD);

    // Run 1
    const receipt1 = await executeOwnerRetention(client, {
      ownerId: "ret-owner",
      beforeIso: CUTOFF,
      dryRun: false,
      now: FIXED_NOW,
    });
    expect(receipt1.deleted).toEqual({ terminalJobs: 1, closedUsage: 1 });

    // Run 2
    const receipt2 = await executeOwnerRetention(client, {
      ownerId: "ret-owner",
      beforeIso: CUTOFF,
      dryRun: false,
      now: FIXED_NOW,
    });
    expect(receipt2.deleted).toEqual({ terminalJobs: 0, closedUsage: 0 });
    expect(receipt2.candidates).toEqual({ terminalJobs: 0, closedUsage: 0 });
  });

  it("enforces strict owner boundary isolation", async () => {
    await insertJob("j-other-done", "ret-other", "done", OLD);
    await insertUsage("u-other-settled", "ret-other", "settled", OLD);

    const receipt = await executeOwnerRetention(client, {
      ownerId: "ret-owner",
      beforeIso: CUTOFF,
      dryRun: false,
      now: FIXED_NOW,
    });

    expect(receipt.candidates).toEqual({ terminalJobs: 0, closedUsage: 0 });
    expect(receipt.deleted).toEqual({ terminalJobs: 0, closedUsage: 0 });
    expect(await ids("jobs")).toEqual(["j-other-done"]);
    expect(await ids("usage_ledger")).toEqual(["u-other-settled"]);
  });

  it("pruneOwnerHistory backwards compatibility wrapper works as expected", async () => {
    await insertJob("j-old-done", "ret-owner", "done", OLD);
    await insertUsage("u-old-settled", "ret-owner", "settled", OLD);

    const result = await pruneOwnerHistory(client, "ret-owner", CUTOFF);
    expect(result).toEqual({ jobsDeleted: 1, usageDeleted: 1 });
    expect(await ids("jobs")).toEqual([]);
    expect(await ids("usage_ledger")).toEqual([]);
  });
});
