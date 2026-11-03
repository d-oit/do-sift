import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Repositories,
  TenantMembershipDirectory,
  applyMigrations,
  loadMigrations,
} from "../src/index.js";

let client: Client;
let memberships: TenantMembershipDirectory;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  const repos = new Repositories(client, "acme");
  await repos.tenants.ensure("acme", "Acme");
  await repos.tenants.ensure("globex", "Globex");
  memberships = new TenantMembershipDirectory(client);
});

describe("TenantMembershipDirectory (issue #120, MT-07)", () => {
  it("reads fail closed for non-members and empty identities", async () => {
    await expect(memberships.roleOf("acme", "u1")).resolves.toBeUndefined();
    await memberships.add("acme", "u1", "member");
    await expect(memberships.roleOf("acme", "u1")).resolves.toBe("member");
    // Same user id, different tenant: never a member there.
    await expect(memberships.roleOf("globex", "u1")).resolves.toBeUndefined();
    await expect(memberships.roleOf("", "u1")).resolves.toBeUndefined();
    await expect(memberships.roleOf("acme", "")).resolves.toBeUndefined();
    await expect(memberships.roleOf("unknown-tenant", "u1")).resolves.toBeUndefined();
  });

  it("updates roles in place and lists both directions", async () => {
    await memberships.add("acme", "u1", "viewer");
    await memberships.add("acme", "u1", "owner");
    await memberships.add("acme", "u2", "member");
    await memberships.add("globex", "u1", "member");

    await expect(memberships.roleOf("acme", "u1")).resolves.toBe("owner");
    await expect(memberships.members("acme")).resolves.toEqual([
      { userId: "u1", role: "owner", createdAt: expect.any(String) },
      { userId: "u2", role: "member", createdAt: expect.any(String) },
    ]);
    await expect(memberships.tenantsOf("u1")).resolves.toEqual(["acme", "globex"]);
    await expect(memberships.tenantsOf("u2")).resolves.toEqual(["acme"]);
    await expect(memberships.tenantsOf("")).resolves.toEqual([]);
  });

  it("refuses writes that would widen access silently", async () => {
    await expect(memberships.add("unknown-tenant", "u1", "member")).rejects.toThrow(
      /unknown tenant/,
    );
    await expect(memberships.add("acme", "", "member")).rejects.toThrow(/user id/);
    await expect(memberships.add("acme", "u1", "admin" as unknown as "member")).rejects.toThrow(
      /unknown tenant role/,
    );
  });

  it("removes memberships", async () => {
    await memberships.add("acme", "u1", "member");
    await expect(memberships.remove("acme", "u1")).resolves.toBe(true);
    await expect(memberships.remove("acme", "u1")).resolves.toBe(false);
    await expect(memberships.roleOf("acme", "u1")).resolves.toBeUndefined();
  });
});

describe("membership change log (issue #120, MT-10)", () => {
  it("records add, re-role, and remove in order with before/after roles", async () => {
    await memberships.add("acme", "u1", "member", "owner-1");
    await memberships.add("acme", "u1", "owner", "owner-2");
    await expect(memberships.remove("acme", "u1", "owner-2")).resolves.toBe(true);

    const changes = await memberships.changes("acme");
    expect(changes.map((change) => change.action)).toEqual(["removed", "role-changed", "added"]);
    expect(changes[2]).toMatchObject({
      actorUserId: "owner-1",
      targetUserId: "u1",
      toRole: "member",
    });
    expect(changes[2]?.fromRole).toBeUndefined();
    expect(changes[1]).toMatchObject({
      actorUserId: "owner-2",
      fromRole: "member",
      toRole: "owner",
    });
    expect(changes[0]).toMatchObject({ actorUserId: "owner-2", fromRole: "owner" });
    expect(changes[0]?.toRole).toBeUndefined();
    expect(changes[0]?.tenantId).toBe("acme");
    expect(typeof changes[0]?.at).toBe("string");
  });

  it("logs nothing for a no-op write or a missing row", async () => {
    await memberships.add("acme", "u1", "member");
    await memberships.add("acme", "u1", "member");
    await expect(memberships.remove("acme", "u2")).resolves.toBe(false);
    await expect(memberships.changes("acme")).resolves.toHaveLength(1);
  });

  it("keeps tenants apart and records non-owner actors as system", async () => {
    await memberships.add("acme", "u1", "member");
    await memberships.add("globex", "u1", "member");
    await expect(memberships.changes("globex")).resolves.toMatchObject([
      { tenantId: "globex", actorUserId: "system", action: "added" },
    ]);
    await expect(memberships.changes("unknown-tenant")).resolves.toEqual([]);
    await expect(memberships.changes("")).resolves.toEqual([]);
  });

  it("caps the history it returns", async () => {
    for (let i = 0; i < 5; i += 1) {
      await memberships.add("acme", `u${i}`, "member");
    }
    await expect(memberships.changes("acme", 2)).resolves.toHaveLength(2);
    await expect(memberships.changes("acme", 0)).resolves.toHaveLength(1);
  });
});
