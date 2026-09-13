/**
 * Migration runner (CORE-01, ADR 0002). Forward-only, explicit SQL, no ORM
 * auto-sync. Each migration runs inside a libSQL transaction together with
 * its schema_migrations bookkeeping row, so a failed migration leaves no
 * partial schema. Applied migrations are hash-pinned: editing the SQL of an
 * applied migration is refused (write a new migration instead).
 *
 * Host-side module — the CORE-02 storage plugin will expose this through a
 * kernel service; plugins never run migrations directly.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client, Transaction } from "@libsql/client";

export interface Migration {
  /** 4-digit chain number; strictly increasing, never reused. */
  number: number;
  name: string;
  sql: string;
}

export interface AppliedMigration {
  number: number;
  name: string;
  hash: string;
  appliedAt: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** sha256 of the SQL, hex — pins applied migrations against edits. */
export function hashMigrationSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function applyOne(client: Client, migration: Migration, hash: string): Promise<void> {
  let tx: Transaction;
  try {
    tx = await client.transaction("write");
  } catch (e) {
    throw new MigrationError(
      `migration ${migration.number} (${migration.name}) failed to open transaction: ${String(e)}`,
    );
  }
  try {
    await tx.executeMultiple(migration.sql);
    await tx.execute({
      sql: "INSERT INTO schema_migrations (number, name, hash, applied_at) VALUES (?, ?, ?, ?)",
      args: [migration.number, migration.name, hash, new Date().toISOString()],
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw new MigrationError(
      `migration ${migration.number} (${migration.name}) failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Apply pending migrations in order. Returns the rows newly applied by this
 * call. Already-applied numbers are skipped after verifying their hash;
 * anything else (edited SQL, out-of-order numbers, duplicate numbers,
 * non-increasing input) fails closed.
 */
export async function applyMigrations(
  client: Client,
  migrations: readonly Migration[],
): Promise<AppliedMigration[]> {
  let previous = -Infinity;
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.number) || m.number <= 0) {
      throw new MigrationError(`migration number must be a positive integer, got ${m.number}`);
    }
    if (seen.has(m.number)) throw new MigrationError(`duplicate migration number ${m.number}`);
    if (m.number <= previous) {
      throw new MigrationError(
        `migrations must be strictly increasing: ${m.number} after ${previous}`,
      );
    }
    seen.add(m.number);
    previous = m.number;
  }

  await client.executeMultiple(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       number INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       hash TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );

  const applied = new Map<number, AppliedMigration>();
  const res = await client.execute("SELECT number, name, hash, applied_at FROM schema_migrations");
  for (const row of res.rows) {
    applied.set(Number(row.number), {
      number: Number(row.number),
      name: String(row.name),
      hash: String(row.hash),
      appliedAt: String(row.applied_at),
    });
  }
  const maxApplied = applied.size === 0 ? -Infinity : Math.max(...applied.keys());

  const fresh: AppliedMigration[] = [];
  for (const m of migrations) {
    const existing = applied.get(m.number);
    if (existing) {
      const hash = hashMigrationSql(m.sql);
      if (existing.hash !== hash) {
        throw new MigrationError(
          `migration ${m.number} (${m.name}) was modified after it was applied — write a new migration instead of editing this one`,
        );
      }
      continue;
    }
    if (m.number < maxApplied) {
      throw new MigrationError(
        `out-of-order migration ${m.number} (${m.name}): ${maxApplied} is already applied`,
      );
    }
    const hash = hashMigrationSql(m.sql);
    await applyOne(client, m, hash);
    const record: AppliedMigration = {
      number: m.number,
      name: m.name,
      hash,
      appliedAt: new Date().toISOString(),
    };
    applied.set(m.number, record);
    fresh.push(record);
  }
  return fresh;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/u;

/**
 * Load numbered .sql files from a directory (host-side; uses fs). Files are
 * sorted by number; anything not matching NNNN_name.sql is an error so a
 * stray file can never silently leave the chain.
 */
export function loadMigrations(dir: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new MigrationError(`cannot read migrations directory ${dir}: ${String(e)}`);
  }
  const migrations: Migration[] = [];
  for (const file of entries.sort()) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) {
      throw new MigrationError(
        `unexpected file in migrations directory: ${file} — only NNNN_name.sql files belong here`,
      );
    }
    migrations.push({
      number: Number.parseInt(m[1] ?? "", 10),
      name: m[2] ?? "",
      sql: readFileSync(join(dir, file), "utf8"),
    });
  }
  if (migrations.length === 0) {
    throw new MigrationError(`no numbered migrations found in ${dir}`);
  }
  return migrations;
}
