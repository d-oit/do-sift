/**
 * Backup/restore rehearsal (OPS-01, plan 007, ADR 0002). Backup is a
 * consistent SQLite snapshot via `VACUUM INTO` — one statement, no locking
 * games, valid as a standalone database file. "Restore" is opening that
 * snapshot; `verifyRestore` proves the copy matches (per-table row counts
 * plus the owners registry's full content).
 *
 * Local engines only: `VACUUM INTO <path>` writes server-side, which is
 * exactly right for `file:`/`:memory:` databases and meaningless for
 * remote Turso — refusing those with the documented remote procedure.
 */
import { createClient, type Client } from "@libsql/client";

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/** Local libSQL URLs only (file: and :memory:); remote URLs get Turso guidance. */
export function assertLocalLibsqlUrl(url: string): void {
  const u = url.trim().toLowerCase();
  if (u === ":memory:" || u.startsWith("file:")) return;
  throw new BackupError(
    `backupToFile works on local libSQL databases only (got "${url}"). For remote Turso databases use the documented procedure: turso db dump / platform snapshots (plans/007 OPS-01, ADR 0002).`,
  );
}

function escapeSqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * Write a consistent snapshot of the database to destPath. The destination
 * must not exist (VACUUM INTO refuses existing files — that refusal is the
 * backup tool's "never overwrite" safety).
 */
export async function backupToFile(client: Client, destPath: string, url?: string): Promise<void> {
  if (url !== undefined) assertLocalLibsqlUrl(url);
  await client.execute(`VACUUM INTO ${escapeSqlString(destPath)}`);
}

/** Open a backup snapshot as its own client — this IS the restore. */
export function openRestore(destPath: string): Client {
  return createClient({ url: `file:${destPath.replace(/\\/gu, "/")}` });
}

async function userTables(client: Client): Promise<string[]> {
  const res = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'passages_fts_%' ORDER BY name",
  );
  return res.rows.map((r) => String(r.name));
}

/**
 * Verify a restored snapshot against the original: identical table set,
 * identical per-table row counts, and byte-identical owners registry.
 * Throws on the first divergence.
 */
export async function verifyRestore(original: Client, restored: Client): Promise<void> {
  const origTables = await userTables(original);
  const restTables = await userTables(restored);
  if (origTables.join(",") !== restTables.join(",")) {
    throw new BackupError(
      `table sets differ: original [${origTables.join(", ")}] vs restored [${restTables.join(", ")}]`,
    );
  }
  for (const table of origTables) {
    const a = await original.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
    const b = await restored.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
    if (Number(a.rows[0]?.n) !== Number(b.rows[0]?.n)) {
      throw new BackupError(
        `row count differs for ${table}: ${Number(a.rows[0]?.n)} vs ${Number(b.rows[0]?.n)}`,
      );
    }
  }
  const origOwners = await original.execute(
    "SELECT id, display_name, created_at FROM owners ORDER BY id",
  );
  const restOwners = await restored.execute(
    "SELECT id, display_name, created_at FROM owners ORDER BY id",
  );
  if (JSON.stringify(origOwners.rows) !== JSON.stringify(restOwners.rows)) {
    throw new BackupError("owners registry content differs after restore");
  }
}
