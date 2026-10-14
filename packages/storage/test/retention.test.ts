import { createClient, type Client } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, pruneOwnerHistory } from "../src/index.js";

let client: Client;

const OLD = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2026-06-01T00:00:00.000Z";

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

async function ids(table: "jobs" | "usage_ledger"): Promise<string[]> {
  const res = await client.execute(`SELECT id FROM ${table} ORDER BY id`);
  return res.rows.map((r) => String(r.id));
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  for (const id of ["ret-owner", "ret-other"]) {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, ?)",
      args: [id, id, OLD],
    });
  }
});

describe("pruneOwnerHistory (#64)", () => {
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

    const result = await pruneOwnerHistory(client, "ret-owner", CUTOFF);

    expect(result).toEqual({ jobsDeleted: 2, usageDeleted: 2 });
    expect(await ids("jobs")).toEqual(
      ["j-new-done", "j-old-leased", "j-old-queued", "j-other-done"].sort(),
    );
    expect(await ids("usage_ledger")).toEqual(
      ["u-new-settled", "u-old-open", "u-other-settled"].sort(),
    );
  });

  it("rejects a malformed cutoff instead of deleting everything", async () => {
    await expect(pruneOwnerHistory(client, "ret-owner", "not-a-date")).rejects.toThrow(
      /valid ISO timestamp/,
    );
  });
});
