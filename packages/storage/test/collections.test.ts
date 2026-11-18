import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { CollectionsRepository, applyMigrations, loadMigrations } from "../src/index.js";

let client: Client;

async function seedOwner(owner: string, tenant = "default"): Promise<void> {
  await client.execute({
    sql: "INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
    args: [tenant, tenant, "2026-11-17T00:00:00Z"],
  });
  await client.execute({
    sql: "INSERT INTO owners (id, tenant_id, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    args: [owner, tenant, owner, "2026-11-17T00:00:00Z"],
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await seedOwner("owner-a");
  await seedOwner("owner-b");
  await seedOwner("tenant-x-owner", "tenant-x");
});

describe("collections repository", () => {
  it("creates, lists, renames, and archives within one owner scope", async () => {
    const repo = new CollectionsRepository(client, "owner-a");
    const created = await repo.create("Reading list", "notes about sources");
    expect(created.title).toBe("Reading list");
    expect((await repo.list()).map((c) => c.id)).toEqual([created.id]);

    expect(await repo.update(created.id, { title: "Renamed" })).toBe(true);
    expect((await repo.get(created.id))?.title).toBe("Renamed");

    expect(await repo.archive(created.id)).toBe(true);
    expect((await repo.get(created.id))?.archivedAt).toBeDefined();
    expect(await repo.list()).toEqual([]);
    expect((await repo.list({ includeArchived: true })).length).toBe(1);
  });

  it("does not read or mutate another owner's collection", async () => {
    const a = new CollectionsRepository(client, "owner-a");
    const b = new CollectionsRepository(client, "owner-b");
    const created = await a.create("A only");

    expect(await b.get(created.id)).toBeUndefined();
    expect(await b.update(created.id, { title: "hijack" })).toBe(false);
    expect(await b.archive(created.id)).toBe(false);
    await expect(b.addItem(created.id, "evidence", "ev-1")).rejects.toThrow(/not found/u);
    expect((await a.get(created.id))?.title).toBe("A only");
  });

  it("does not cross tenants even with the same owner id", async () => {
    const tenantOwner = new CollectionsRepository(client, "tenant-x-owner", "tenant-x");
    const created = await tenantOwner.create("Tenant X");
    const defaultTenant = new CollectionsRepository(client, "tenant-x-owner", "default");
    expect(await defaultTenant.get(created.id)).toBeUndefined();
    expect((await tenantOwner.list()).length).toBe(1);
  });

  it("references existing items without copying evidence and dedupes additions", async () => {
    const repo = new CollectionsRepository(client, "owner-a");
    const collection = await repo.create("Refs");
    await repo.addItem(collection.id, "evidence", "ev-1");
    await repo.addItem(collection.id, "evidence", "ev-1");
    await repo.addItem(collection.id, "run", "run-1");
    expect(await repo.items(collection.id)).toEqual([
      expect.objectContaining({ itemKind: "evidence", itemId: "ev-1" }),
      expect.objectContaining({ itemKind: "run", itemId: "run-1" }),
    ]);
    expect(await repo.removeItem(collection.id, "evidence", "ev-1")).toBe(true);
    expect((await repo.items(collection.id)).map((i) => i.itemId)).toEqual(["run-1"]);
  });

  it("reads every attachment for exports while the detail view stays capped", async () => {
    const repo = new CollectionsRepository(client, "owner-a");
    const collection = await repo.create("Large collection");
    for (let i = 0; i < 101; i++) {
      await repo.addItem(collection.id, "run", `run-${String(i).padStart(3, "0")}`);
    }

    expect(await repo.items(collection.id)).toHaveLength(100);
    expect(await repo.countItems(collection.id)).toBe(101);
    const all = await repo.allItems(collection.id);
    expect(all).toHaveLength(101);
    expect(all.at(-1)?.itemId).toBe("run-100");
    expect(await repo.itemsUpTo(collection.id, 2)).toHaveLength(2);
    await expect(repo.itemsUpTo(collection.id, 0)).rejects.toThrow(/positive integer/u);
    expect(await new CollectionsRepository(client, "owner-b").countItems(collection.id)).toBe(0);

    const first = await repo.itemsPage(collection.id, 100);
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const last = first.items.at(-1);
    if (last === undefined) throw new Error("expected a first-page item");
    const second = await repo.itemsPage(collection.id, 100, {
      addedAt: last.addedAt,
      itemKind: last.itemKind,
      itemId: last.itemId,
    });
    expect(second.items.map((item) => item.itemId)).toEqual(["run-100"]);
    expect(second.hasMore).toBe(false);
  });

  it("snapshots resolvable evidence provenance for report assembly", async () => {
    await client.execute({
      sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, created_at)
            VALUES ('doc-1', 'default', 'owner-a', 'https://a.test/p', 'https://a.test/p', 'hash-1', '2026-11-01T00:00:00Z', 'Alpha', '2026-11-01T00:00:00Z')`,
    });
    await client.execute({
      sql: `INSERT INTO passages (id, tenant_id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
            VALUES ('psg-1', 'default', 'owner-a', 'doc-1', 'H', 'Excerpt', 'ok', '2026-11-01T00:00:01Z')`,
    });
    const repo = new CollectionsRepository(client, "owner-a");
    const collection = await repo.create("Reported");
    await repo.addItem(collection.id, "evidence", "doc-1");
    expect((await repo.items(collection.id))[0]).toMatchObject({
      itemId: "doc-1",
      evidenceUrl: "https://a.test/p",
      evidenceTitle: "Alpha",
      evidenceFetchedAt: "2026-11-01T00:00:00Z",
    });

    // A reference the corpus cannot resolve is still a reference, with no
    // invented snapshot.
    await repo.addItem(collection.id, "evidence", "unresolved-id");
    const unresolved = (await repo.items(collection.id)).find(
      (item) => item.itemId === "unresolved-id",
    );
    expect(unresolved?.evidenceUrl).toBeUndefined();
  });

  it("backfills metadata for evidence references attached before the snapshot", async () => {
    await client.execute({
      sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, created_at)
            VALUES ('doc-legacy', 'default', 'owner-a', 'https://legacy.test/p', 'https://legacy.test/p', 'hash-legacy', '2026-10-01T00:00:00Z', 'Legacy', '2026-10-01T00:00:00Z')`,
    });
    await client.execute({
      sql: `INSERT INTO passages (id, tenant_id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
            VALUES ('psg-legacy', 'default', 'owner-a', 'doc-legacy', 'H', 'Excerpt', 'ok', '2026-10-01T00:00:01Z')`,
    });
    const repo = new CollectionsRepository(client, "owner-a");
    const collection = await repo.create("Legacy refs");
    // Simulate rows created before migration 0015: the reference exists, the
    // provenance snapshot does not.
    await client.execute({
      sql: `INSERT INTO collection_items (collection_id, tenant_id, owner_id, item_kind, item_id, added_at)
            VALUES (?, 'default', 'owner-a', 'evidence', 'doc-legacy', '2026-10-02T00:00:00Z'),
                   (?, 'default', 'owner-a', 'evidence', 'still-missing', '2026-10-03T00:00:00Z')`,
      args: [collection.id, collection.id],
    });

    const dryRun = await repo.backfillEvidenceMetadata({ dryRun: true });
    expect(dryRun).toEqual({ scanned: 2, updated: 1, unresolved: 1, dryRun: true });
    expect((await repo.items(collection.id))[0]?.evidenceUrl).toBeUndefined();

    expect(await repo.backfillEvidenceMetadata()).toEqual({
      scanned: 2,
      updated: 1,
      unresolved: 1,
      dryRun: false,
    });
    const items = await repo.items(collection.id);
    expect(items.find((item) => item.itemId === "doc-legacy")).toMatchObject({
      evidenceUrl: "https://legacy.test/p",
      evidenceTitle: "Legacy",
      evidenceFetchedAt: "2026-10-01T00:00:00Z",
    });
    expect(items.find((item) => item.itemId === "still-missing")?.evidenceUrl).toBeUndefined();

    // Only the still-unresolved reference is scanned on a later run.
    expect(await repo.backfillEvidenceMetadata()).toMatchObject({ scanned: 1, updated: 0 });
    expect(
      await new CollectionsRepository(client, "owner-b").backfillEvidenceMetadata(),
    ).toMatchObject({ scanned: 0, updated: 0 });
  });

  it("keeps notes as authored metadata with an explicit author", async () => {
    const repo = new CollectionsRepository(client, "owner-a");
    const collection = await repo.create("Notes");
    const note = await repo.addNote(
      collection.id,
      "This disagrees with the other source.",
      "member-1",
    );
    expect(note.authorId).toBe("member-1");
    expect((await repo.notes(collection.id))[0]?.body).toContain("disagrees");
    expect(await repo.deleteNote(note.id)).toBe(true);
    expect(await repo.notes(collection.id)).toEqual([]);
  });

  it("bounds titles, descriptions, notes, and list limits", async () => {
    const repo = new CollectionsRepository(client, "owner-a");
    await expect(repo.create("")).rejects.toThrow(/title/u);
    await expect(repo.create("x".repeat(201))).rejects.toThrow(/title/u);
    await expect(repo.create("ok", "x".repeat(2001))).rejects.toThrow(/description/u);
    const collection = await repo.create("ok");
    await expect(repo.addNote(collection.id, "x".repeat(8001))).rejects.toThrow(/note body/u);
    await expect(repo.list({ limit: 0 })).rejects.toThrow(/limit/u);
    await expect(repo.itemsPage(collection.id, 0)).rejects.toThrow(/limit/u);
    await expect(repo.create("archived")).resolves.toBeDefined();
    const archived = await repo.create("archived-2");
    await repo.archive(archived.id);
    await expect(repo.addItem(archived.id, "evidence", "ev-1")).rejects.toThrow(/archived/u);
  });
});
