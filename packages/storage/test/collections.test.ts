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
    await expect(repo.create("archived")).resolves.toBeDefined();
    const archived = await repo.create("archived-2");
    await repo.archive(archived.id);
    await expect(repo.addItem(archived.id, "evidence", "ev-1")).rejects.toThrow(/archived/u);
  });
});
