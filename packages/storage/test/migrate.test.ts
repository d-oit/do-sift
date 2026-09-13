import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  MigrationError,
  applyMigrations,
  hashMigrationSql,
  loadMigrations,
  type Migration,
} from "../src/index.js";

function memoryClient(): Client {
  return createClient({ url: ":memory:" });
}

const m1: Migration = {
  number: 1,
  name: "owners",
  sql: "CREATE TABLE owners (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);",
};
const m2: Migration = {
  number: 2,
  name: "notes",
  sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), body TEXT NOT NULL);",
};

describe("applyMigrations", () => {
  it("applies all migrations in order on a fresh database", async () => {
    const client = memoryClient();
    const applied = await applyMigrations(client, [m1, m2]);
    expect(applied.map((a) => a.number)).toEqual([1, 2]);
    const rows = await client.execute("SELECT number, name FROM schema_migrations ORDER BY number");
    expect(rows.rows.map((r) => `${r.number}:${r.name}`)).toEqual(["1:owners", "2:notes"]);
    // the schema actually exists and works, with an owner-scoped insert
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, ?)",
      args: ["owner-1", "Owner One", "2026-09-06T00:00:00Z"],
    });
    const owners = await client.execute("SELECT id FROM owners");
    expect(owners.rows).toHaveLength(1);
  });

  it("is a no-op when everything is already applied", async () => {
    const client = memoryClient();
    await applyMigrations(client, [m1, m2]);
    const second = await applyMigrations(client, [m1, m2]);
    expect(second).toEqual([]);
    const rows = await client.execute("SELECT COUNT(*) AS n FROM schema_migrations");
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });

  it("refuses to run edited SQL for an already-applied migration", async () => {
    const client = memoryClient();
    await applyMigrations(client, [m1]);
    const tampered = { ...m1, sql: `${m1.sql}\nALTER TABLE owners ADD COLUMN evil TEXT;` };
    expect(tampered.sql).not.toBe(m1.sql);
    await expect(applyMigrations(client, [tampered])).rejects.toThrow(
      /modified after it was applied/,
    );
  });

  it("hashes deterministically", () => {
    expect(hashMigrationSql(m1.sql)).toBe(hashMigrationSql(`${m1.sql}`));
    expect(hashMigrationSql(m1.sql)).not.toBe(hashMigrationSql(m2.sql));
  });

  it("refuses out-of-order and duplicate migration numbers", async () => {
    const client = memoryClient();
    // a new migration numbered below the applied maximum is out-of-order
    // (m2 applied alone; m1 arrives late with a lower number)
    await applyMigrations(client, [m2]);
    await expect(applyMigrations(client, [m1])).rejects.toThrow(/out-of-order/);
    const dup = [m1, { ...m1 }];
    await expect(applyMigrations(memoryClient(), dup)).rejects.toThrow(
      /duplicate migration number/,
    );
  });

  it("rolls back completely when a migration fails mid-way", async () => {
    const client = memoryClient();
    const bad: Migration = {
      number: 3,
      name: "bad",
      sql: "CREATE TABLE half_written (id TEXT); INSERT INTO no_such_table VALUES (1);",
    };
    await expect(applyMigrations(client, [m1, bad])).rejects.toThrow(/rolled back/);
    // m1 survived; neither the failed DDL nor its bookkeeping row did
    const rows = await client.execute("SELECT COUNT(*) AS n FROM schema_migrations");
    expect(Number(rows.rows[0]?.n)).toBe(1);
    const half = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='half_written'",
    );
    expect(half.rows).toHaveLength(0);
    const owners = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='owners'",
    );
    expect(owners.rows).toHaveLength(1);
  });

  it("validates migration numbers", async () => {
    await expect(applyMigrations(memoryClient(), [{ ...m1, number: 0 }])).rejects.toThrow(
      MigrationError,
    );
  });
});

describe("loadMigrations", () => {
  it("loads and sorts the repo's own migration chain", () => {
    const migrations = loadMigrations(join(process.cwd(), "migrations"));
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]?.number).toBe(1);
    expect(migrations[0]?.name).toBe("owners");
    const numbers = migrations.map((m) => m.number);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
  });

  it("rejects stray files in the migrations directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-mig-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "0001_good.sql"), "CREATE TABLE t (id TEXT);");
    writeFileSync(join(dir, "README.txt"), "stray file");
    expect(() => loadMigrations(dir)).toThrow(/stray|cannot read|no numbered|README/u);
  });

  it("applies what the loader returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-mig-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "0001_owners.sql"), `${m1.sql}\n`);
    writeFileSync(join(dir, "0002_notes.sql"), `${m2.sql}\n`);
    const client = memoryClient();
    const applied = await applyMigrations(client, loadMigrations(dir));
    expect(applied.map((a) => a.number)).toEqual([1, 2]);
  });
});
