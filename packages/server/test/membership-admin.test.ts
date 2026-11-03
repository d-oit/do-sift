/**
 * Membership administration (issue #120, MT-09/MT-10): the tenant always comes
 * from the authenticated principal, the authority is the recorded role (never
 * a claim), an owner can never lock a tenant out by editing their own row, and
 * every accepted change lands in an owner-readable log.
 */
import type { Server } from "node:http";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@do-sift/auth";
import {
  Repositories,
  TenantMembershipDirectory,
  applyMigrations,
  loadMigrations,
} from "@do-sift/storage";
import { createResearchServer, listen, type ResearchServerOptions } from "../src/index.js";

const MEMBERS = "/api/admin/members";
const CHANGES = "/api/admin/member-changes";

let client: Client;
let memberships: TenantMembershipDirectory;
let server: Server;
let port: number;
let bareServer: Server;
let barePort: number;

const TOKENS: Record<string, { ownerId: string; tenantId: string }> = {
  "token-acme-owner": { ownerId: "owner-acme", tenantId: "acme" },
  "token-acme-member": { ownerId: "member-acme", tenantId: "acme" },
  "token-acme-viewer": { ownerId: "viewer-acme", tenantId: "acme" },
  "token-acme-stranger": { ownerId: "stranger", tenantId: "acme" },
  "token-globex-owner": { ownerId: "owner-globex", tenantId: "globex" },
};

const auth: ResearchServerOptions["auth"] = {
  authenticateOwner: async ({ token }) => {
    const principal = token === undefined ? undefined : TOKENS[token];
    if (principal === undefined) throw new AuthError("invalid-token", "no usable token");
    return { ownerId: principal.ownerId, via: "oidc", tenantId: principal.tenantId };
  },
};

const emptyRun: ResearchServerOptions["runResearch"] = async () => ({
  hits: 0,
  documentsStored: 0,
  passagesStored: 0,
  denied: 0,
  fetchErrors: 0,
  skippedBudget: 0,
});

interface CallOptions {
  token?: string;
  method?: string;
  body?: unknown;
}

async function call(path: string, init: CallOptions = {}, base = port): Promise<Response> {
  return fetch(`http://127.0.0.1:${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

interface ChangeBody {
  tenantId: string;
  changes: Array<{
    id: number;
    tenantId: string;
    actorUserId: string;
    targetUserId: string;
    action: string;
    fromRole?: string;
    toRole?: string;
    at: string;
  }>;
}

async function history(token: string): Promise<ChangeBody> {
  const response = await call(CHANGES, { token });
  expect(response.status).toBe(200);
  return (await response.json()) as ChangeBody;
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  const acme = new Repositories(client, "acme");
  const globex = new Repositories(client, "globex");
  await acme.tenants.ensure("acme", "Acme");
  await globex.tenants.ensure("globex", "Globex");
  memberships = new TenantMembershipDirectory(client);
  await memberships.add("acme", "owner-acme", "owner");
  await memberships.add("acme", "member-acme", "member");
  await memberships.add("acme", "viewer-acme", "viewer");
  await memberships.add("globex", "owner-globex", "owner");

  const admin = {
    roleOf: (tenantId: string, userId: string) => memberships.roleOf(tenantId, userId),
    list: (tenantId: string) => memberships.members(tenantId),
    upsert: (
      tenantId: string,
      userId: string,
      role: "owner" | "member" | "viewer",
      actor: string,
    ) => memberships.add(tenantId, userId, role, actor),
    remove: (tenantId: string, userId: string, actor: string) =>
      memberships.remove(tenantId, userId, actor),
    changes: (tenantId: string) => memberships.changes(tenantId),
  };

  server = createResearchServer({ auth, runResearch: emptyRun, membershipAdmin: admin });
  port = await listen(server);
  // Multi-tenant is not the only posture: without the admin handlers the
  // surface does not exist at all.
  bareServer = createResearchServer({ auth, runResearch: emptyRun });
  barePort = await listen(bareServer);
});

afterAll(() => {
  server.close();
  bareServer.close();
});

describe("GET /api/admin/members", () => {
  it("lists the caller's own tenant for a recorded owner", async () => {
    const response = await call(MEMBERS, { token: "token-acme-owner" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      tenantId: string;
      members: Array<{ userId: string; role: string }>;
    };
    expect(body.tenantId).toBe("acme");
    expect(body.members.map((m) => m.userId).sort()).toEqual([
      "member-acme",
      "owner-acme",
      "viewer-acme",
    ]);
    expect(body.members.find((m) => m.userId === "member-acme")?.role).toBe("member");
  });

  it("never shows another tenant's members", async () => {
    const response = await call(MEMBERS, { token: "token-globex-owner" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenantId: string;
      members: Array<{ userId: string }>;
    };
    expect(body.tenantId).toBe("globex");
    expect(body.members.map((m) => m.userId)).toEqual(["owner-globex"]);
  });

  it("answers 403 to members, viewers, and non-members alike", async () => {
    for (const token of ["token-acme-member", "token-acme-viewer", "token-acme-stranger"]) {
      const response = await call(MEMBERS, { token });
      expect(response.status).toBe(403);
      expect((await response.json()) as { error: string }).toMatchObject({ error: "forbidden" });
    }
  });

  it("answers 401 without a usable token", async () => {
    const response = await call(MEMBERS);
    expect(response.status).toBe(401);
  });
});

describe("PUT /api/admin/members/<id>", () => {
  it("adds a member, then re-roles it, in the caller's tenant only", async () => {
    const added = await call(`${MEMBERS}/new-user`, {
      method: "PUT",
      token: "token-acme-owner",
      body: { role: "member" },
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      tenantId: "acme",
      member: { userId: "new-user", role: "member" },
    });
    expect(await memberships.roleOf("acme", "new-user")).toBe("member");
    expect(await memberships.roleOf("globex", "new-user")).toBeUndefined();

    const demoted = await call(`${MEMBERS}/new-user`, {
      method: "PUT",
      token: "token-acme-owner",
      body: { role: "viewer" },
    });
    expect(demoted.status).toBe(200);
    expect(await memberships.roleOf("acme", "new-user")).toBe("viewer");
  });

  it("acts on the caller's tenant, so a globex owner cannot touch acme", async () => {
    const response = await call(`${MEMBERS}/globex-only`, {
      method: "PUT",
      token: "token-globex-owner",
      body: { role: "member" },
    });
    expect(response.status).toBe(200);
    expect(await memberships.roleOf("globex", "globex-only")).toBe("member");
    expect(await memberships.roleOf("acme", "globex-only")).toBeUndefined();
  });

  it("rejects unknown roles and extra fields without writing", async () => {
    for (const body of [{ role: "admin" }, { role: "member", extra: true }, {}]) {
      const response = await call(`${MEMBERS}/sneaky`, {
        method: "PUT",
        token: "token-acme-owner",
        body,
      });
      expect(response.status).toBe(400);
      await response.text();
    }
    expect(await memberships.roleOf("acme", "sneaky")).toBeUndefined();
  });

  it("refuses an owner re-roling their own row", async () => {
    const response = await call(`${MEMBERS}/owner-acme`, {
      method: "PUT",
      token: "token-acme-owner",
      body: { role: "member" },
    });
    expect(response.status).toBe(400);
    expect(await memberships.roleOf("acme", "owner-acme")).toBe("owner");
  });

  it("refuses member and viewer callers", async () => {
    for (const token of ["token-acme-member", "token-acme-viewer"]) {
      const response = await call(`${MEMBERS}/member-acme`, {
        method: "PUT",
        token,
        body: { role: "owner" },
      });
      expect(response.status).toBe(403);
      await response.text();
    }
    expect(await memberships.roleOf("acme", "member-acme")).toBe("member");
  });
});

describe("DELETE /api/admin/members/<id>", () => {
  it("removes a member and reports a missing row honestly", async () => {
    const first = await call(`${MEMBERS}/new-user`, {
      method: "DELETE",
      token: "token-acme-owner",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ tenantId: "acme", removed: "new-user" });
    expect(await memberships.roleOf("acme", "new-user")).toBeUndefined();

    const second = await call(`${MEMBERS}/new-user`, {
      method: "DELETE",
      token: "token-acme-owner",
    });
    expect(second.status).toBe(404);
  });

  it("refuses an owner removing their own membership", async () => {
    const response = await call(`${MEMBERS}/owner-acme`, {
      method: "DELETE",
      token: "token-acme-owner",
    });
    expect(response.status).toBe(400);
    expect(await memberships.roleOf("acme", "owner-acme")).toBe("owner");
  });
});

describe("GET /api/admin/member-changes", () => {
  it("records who changed what, newest first, with before/after roles", async () => {
    await call(`${MEMBERS}/audited`, {
      method: "PUT",
      token: "token-acme-owner",
      body: { role: "member" },
    });
    await call(`${MEMBERS}/audited`, {
      method: "PUT",
      token: "token-acme-owner",
      body: { role: "viewer" },
    });
    await call(`${MEMBERS}/audited`, { method: "DELETE", token: "token-acme-owner" });

    const body = await history("token-acme-owner");
    expect(body.tenantId).toBe("acme");
    const mine = body.changes.filter((change) => change.targetUserId === "audited");
    expect(mine.map((change) => change.action)).toEqual(["removed", "role-changed", "added"]);
    expect(mine[1]).toMatchObject({
      actorUserId: "owner-acme",
      fromRole: "member",
      toRole: "viewer",
    });
    expect(mine[2]?.fromRole).toBeUndefined();
    expect(mine[2]?.toRole).toBe("member");
    expect(mine[0]?.toRole).toBeUndefined();
    expect(mine[0]?.fromRole).toBe("viewer");
    expect(mine.every((change) => change.tenantId === "acme")).toBe(true);
    expect(mine.every((change) => typeof change.at === "string" && change.at !== "")).toBe(true);
  });

  it("does not log a repeated no-op role", async () => {
    for (let i = 0; i < 2; i += 1) {
      await call(`${MEMBERS}/noop-user`, {
        method: "PUT",
        token: "token-acme-owner",
        body: { role: "member" },
      });
    }
    const body = await history("token-acme-owner");
    expect(body.changes.filter((change) => change.targetUserId === "noop-user")).toHaveLength(1);
  });

  it("logs nothing for refused or rejected requests", async () => {
    await call(`${MEMBERS}/member-acme`, {
      method: "PUT",
      token: "token-acme-member",
      body: { role: "owner" },
    });
    await call(`${MEMBERS}/owner-acme`, {
      method: "DELETE",
      token: "token-acme-owner",
    });
    await call(`${MEMBERS}/bad-role`, {
      method: "PUT",
      token: "token-acme-owner",
      body: { role: "admin" },
    });
    const body = await history("token-acme-owner");
    for (const target of ["member-acme", "owner-acme", "bad-role"]) {
      expect(
        body.changes.filter(
          (change) => change.targetUserId === target && change.actorUserId !== "system",
        ),
      ).toHaveLength(0);
    }
  });

  it("shows each owner only their own tenant's changes", async () => {
    const body = await history("token-globex-owner");
    expect(body.tenantId).toBe("globex");
    expect(body.changes.every((change) => change.tenantId === "globex")).toBe(true);
    expect(body.changes.some((change) => change.targetUserId === "audited")).toBe(false);
  });

  it("keeps the same authorization as the rest of the surface", async () => {
    for (const token of ["token-acme-member", "token-acme-viewer", "token-acme-stranger"]) {
      const response = await call(CHANGES, { token });
      expect(response.status).toBe(403);
      await response.text();
    }
    expect((await call(CHANGES)).status).toBe(401);
    const post = await call(CHANGES, { method: "POST", token: "token-acme-owner" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    await post.text();
    const nested = await call(`${CHANGES}/nested`, { token: "token-acme-owner" });
    expect(nested.status).toBe(404);
    await nested.text();
    expect((await call(CHANGES, { token: "token-acme-owner" }, barePort)).status).toBe(404);
  });
});

describe("surface shape", () => {
  it("rejects unsupported methods with 405 and an allow header", async () => {
    const collection = await call(MEMBERS, { method: "POST", token: "token-acme-owner" });
    expect(collection.status).toBe(405);
    expect(collection.headers.get("allow")).toBe("GET");
    await collection.text();

    const item = await call(`${MEMBERS}/member-acme`, { token: "token-acme-owner" });
    expect(item.status).toBe(405);
    expect(item.headers.get("allow")).toBe("PUT, DELETE");
    await item.text();
  });

  it("treats a nested or encoded id as invalid, not as another route", async () => {
    const nested = await call(`${MEMBERS}/a/b`, { token: "token-acme-owner" });
    expect(nested.status).toBe(404);
    await nested.text();

    const empty = await call(`${MEMBERS}/`, { token: "token-acme-owner" });
    expect(empty.status).toBe(404);
    await empty.text();

    const encoded = await call(`${MEMBERS}/a%2Fb`, {
      method: "DELETE",
      token: "token-acme-owner",
    });
    expect(encoded.status).toBe(400);
    await encoded.text();
  });

  it("is absent (404) when the host does not wire memberships", async () => {
    const response = await call(MEMBERS, { token: "token-acme-owner" }, barePort);
    expect(response.status).toBe(404);
  });
});
