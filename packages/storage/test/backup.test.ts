import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BackupError,
  Repositories,
  applyMigrations,
  assertLocalLibsqlUrl,
  backupToFile,
  loadMigrations,
  openRestore,
  verifyRestore,
} from "../src/index.js";

const WORK = mkdtempSync(join(tmpdir(), "ds-backup-"));
afterAll(() => {
  // Windows can hold SQLite handles briefly past close(); a failed temp-dir
  // cleanup is cosmetic (the OS clears %TEMP%) and must not fail the suite
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* tolerated */
  }
});

let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  await repos.owners.ensure("owner-a", "Owner A");
  const docId = await repos.documents.insert({
    ownerId: "owner-a",
    canonicalUrl: "https://example.test/doc",
    originalUrl: "https://example.test/doc",
    contentHash: "hash-backup-00000001",
    fetchedAt: "2026-09-13T00:00:00Z",
    rawText: "backup rehearsal body",
  });
  await repos.passages.insert({
    ownerId: "owner-a",
    documentId: docId,
    excerpt: "A passage of evidence that must survive backup and restore.",
    extractionStatus: "ok",
  });
  const requestId = await repos.requests.create("owner-a", "answer", "question?");
  await repos.answers.insert({
    ownerId: "owner-a",
    requestId,
    blocks: [{ kind: "paragraph", text: "answer text", citations: [] }],
    evidenceOnly: false,
    cacheKey: "ans:v1:backup01",
  });
});

describe("backupToFile + verifyRestore (OPS-01)", () => {
  it("produces a snapshot that verifies against the live database", async () => {
    const dest = join(WORK, "snapshot-1.db");
    await backupToFile(client, dest, ":memory:");
    const restored = openRestore(dest);
    try {
      await verifyRestore(client, restored);
      // spot check: the answer survived with its content
      const answers = await restored.execute("SELECT blocks_json FROM answers");
      expect(String(answers.rows[0]?.blocks_json)).toContain("answer text");
    } finally {
      restored.close();
    }
  });

  it("post-backup mutations do not leak into the snapshot", async () => {
    const dest = join(WORK, "snapshot-2.db");
    await backupToFile(client, dest, ":memory:");
    await repos.owners.ensure("owner-late", "Created after backup");
    const restored = openRestore(dest);
    try {
      await verifyRestore(client, restored).then(
        () => expect.unreachable("verify should fail: tables/counts diverged after backup"),
        (e: unknown) => expect(e).toBeInstanceOf(BackupError),
      );
      const owners = await restored.execute("SELECT COUNT(*) AS n FROM owners");
      expect(Number(owners.rows[0]?.n)).toBe(1); // only the pre-backup owner
    } finally {
      restored.close();
    }
  });

  it("refuses to overwrite an existing snapshot", async () => {
    const dest = join(WORK, "snapshot-3.db");
    await backupToFile(client, dest, ":memory:");
    await expect(backupToFile(client, dest, ":memory:")).rejects.toThrow();
  });

  it("refuses remote database URLs with Turso guidance", async () => {
    await expect(
      backupToFile(client, join(WORK, "x.db"), "libsql://my-db.turso.io"),
    ).rejects.toThrow(/turso db dump/);
    expect(assertLocalLibsqlUrl("file:local.db")).toBeUndefined();
    expect(assertLocalLibsqlUrl(":memory:")).toBeUndefined();
    expect(() => assertLocalLibsqlUrl("https://db.example.test")).toThrow(BackupError);
  });
});

describe("full restore rehearsal (delete the original, restore from backup)", () => {
  it("survives total loss of the original database file", async () => {
    const dbPath = join(WORK, "original.db");
    const fileDb = createClient({ url: `file:${dbPath.replace(/\\/gu, "/")}` });
    await applyMigrations(fileDb, loadMigrations("migrations"));
    const fileRepos = new Repositories(fileDb);
    await fileRepos.owners.ensure("owner-live", "Live Owner");
    const docId = await fileRepos.documents.insert({
      ownerId: "owner-live",
      canonicalUrl: "https://example.test/live",
      originalUrl: "https://example.test/live",
      contentHash: "hash-live-000000001",
      fetchedAt: "2026-09-13T00:00:00Z",
      rawText: "live body",
    });
    await fileRepos.passages.insert({
      ownerId: "owner-live",
      documentId: docId,
      excerpt: "Live evidence written before the backup was taken.",
      extractionStatus: "ok",
    });

    const backupPath = join(WORK, "rehearsal-backup.db");
    await backupToFile(fileDb, backupPath, `file:${dbPath.replace(/\\/gu, "/")}`);
    await fileDb.close(); // release the handle BEFORE simulating total loss

    // total loss: the original file is gone. On Windows the handle can
    // outlive close() briefly (EPERM) — the simulation then treats the
    // original as ABANDONED rather than deleted; the rehearsal substance
    // is identical: the snapshot alone must contain everything.
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* tolerated: logical loss */
    }

    // restore = open the snapshot; the data survives (verified directly —
    // the original no longer exists to compare against)
    const restored = openRestore(backupPath);
    try {
      const owners = await restored.execute("SELECT display_name FROM owners");
      expect(owners.rows.map((r) => String(r.display_name))).toEqual(["Live Owner"]);
      const passages = await restored.execute("SELECT excerpt FROM passages");
      expect(String(passages.rows[0]?.excerpt)).toContain("Live evidence");
      const fts = await restored.execute(
        "SELECT excerpt FROM passages_fts WHERE passages_fts MATCH 'evidence'",
      );
      expect(fts.rows).toHaveLength(1); // the FTS index snapshot works too
    } finally {
      await restored.close();
    }
  });
});
