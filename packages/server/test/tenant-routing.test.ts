/**
 * Per-principal runtime routing (issue #120, MT-07): one listener, one
 * tenant-bound runtime per tenant, membership checked before either is used.
 */
import type { Server } from "node:http";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@do-sift/auth";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import {
  Repositories,
  TenantMembershipDirectory,
  applyMigrations,
  loadMigrations,
} from "@do-sift/storage";
import {
  TenantAccessError,
  createResearchServer,
  createRuntimeResolver,
  listen,
  resolvePrincipalRuntime,
  type RuntimeResolver,
} from "../src/index.js";

const PAGE = [
  "Delta paragraph explains the tenancy boundary and how each tenant stores its own evidence.",
  "Epsilon paragraph adds supporting detail about the same ranking topic.",
].join("\n\n");

let client: Client;
let memberships: TenantMembershipDirectory;
let resolver: RuntimeResolver;
let server: Server;
let port: number;
const routed: Array<{ tenantId: string; userId: string }> = [];

function search(): FakeSearchProvider {
  return new FakeSearchProvider({
    hits: [{ url: "https://tenant.test/page", title: "Tenant page", snippet: "delta", rank: 0 }],
  });
}

async function postResearch(token: string | undefined): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/research`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ question: "what does delta explain?" }),
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  const acme = new Repositories(client, "acme");
  const globex = new Repositories(client, "globex");
  await acme.tenants.ensure("acme", "Acme");
  await globex.tenants.ensure("globex", "Globex");
  await acme.owners.ensure("owner-acme", "Acme owner");
  await globex.owners.ensure("owner-globex", "Globex owner");

  memberships = new TenantMembershipDirectory(client);
  await memberships.add("acme", "owner-acme", "owner");
  await memberships.add("globex", "owner-globex", "member");

  resolver = await createRuntimeResolver({
    client,
    search: search(),
    fetchPage: async () => ({ text: PAGE, contentType: "text/html" }),
    tenantIds: ["acme", "globex"],
  });

  server = createResearchServer({
    auth: {
      authenticateOwner: async ({ token }) => {
        if (token === "token-acme") {
          return { ownerId: "owner-acme", via: "oidc", tenantId: "acme" };
        }
        if (token === "token-globex") {
          return { ownerId: "owner-globex", via: "oidc", tenantId: "globex" };
        }
        if (token === "token-foreign") {
          // Verified identity, valid tenant — but no membership in it.
          return { ownerId: "owner-globex", via: "oidc", tenantId: "acme" };
        }
        throw new AuthError("invalid-token", "no usable token");
      },
    },
    runtimeFor: async (principal) => {
      routed.push(principal);
      const runtime = await resolvePrincipalRuntime({
        resolver,
        membership: memberships,
        principal,
      });
      return {
        runResearch: (ownerId, question, onSource, signal) =>
          runtime.runResearch(ownerId, question, onSource, signal),
      };
    },
  });
  port = await listen(server);
});

afterAll(() => {
  server.close();
});

describe("createRuntimeResolver", () => {
  it("builds one runtime per tenant, memoizes it, and keeps data apart", async () => {
    const acme = await resolver.resolve("acme");
    const globex = await resolver.resolve("globex");
    expect(acme).not.toBe(globex);
    await expect(resolver.resolve("acme")).resolves.toBe(acme);
    expect(resolver.size).toBe(2);

    await acme.runResearch("owner-acme", "what does delta explain?");
    expect((await acme.repositories.documents.list("owner-acme")).length).toBeGreaterThan(0);
    // The other tenant's runtime sees none of it, under either owner id.
    expect(await globex.repositories.documents.list("owner-acme")).toEqual([]);
    expect(await globex.repositories.documents.list("owner-globex")).toEqual([]);
  });

  it("refuses tenants outside the configured set", async () => {
    await expect(resolver.resolve("initech")).rejects.toMatchObject({ kind: "unknown-tenant" });
    await expect(resolver.resolve("  ")).rejects.toMatchObject({ kind: "unknown-tenant" });
    expect(resolver.has("initech")).toBe(false);
    expect(resolver.has("acme")).toBe(true);
    expect(resolver.get("initech")).toBeUndefined();
  });

  it("bounds how many runtimes one process holds", async () => {
    const capped = await createRuntimeResolver({
      client,
      search: search(),
      fetchPage: async () => ({ text: PAGE, contentType: "text/html" }),
      tenantIds: ["acme", "globex"],
      maxTenants: 1,
    });
    await capped.resolve("acme");
    await expect(capped.resolve("globex")).rejects.toMatchObject({ kind: "too-many-tenants" });
    expect(capped.size).toBe(1);
  });

  it("requires membership before a tenant runtime is resolved", async () => {
    await expect(
      resolvePrincipalRuntime({
        resolver,
        membership: memberships,
        principal: { tenantId: "acme", userId: "owner-acme" },
      }),
    ).resolves.toBe(await resolver.resolve("acme"));

    const error = await resolvePrincipalRuntime({
      resolver,
      membership: memberships,
      principal: { tenantId: "acme", userId: "owner-globex" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantAccessError);
    expect(error).toMatchObject({ kind: "not-a-member" });
  });
});

describe("per-principal runtime routing over HTTP", () => {
  it("routes each authenticated principal to its own tenant runtime", async () => {
    const acmeResponse = await postResearch("token-acme");
    expect(acmeResponse.status).toBe(200);
    await acmeResponse.text();

    const globexResponse = await postResearch("token-globex");
    expect(globexResponse.status).toBe(200);
    await globexResponse.text();

    expect(routed).toEqual([
      { tenantId: "acme", userId: "owner-acme" },
      { tenantId: "globex", userId: "owner-globex" },
    ]);

    const acmeRuntime = await resolver.resolve("acme");
    const globexRuntime = await resolver.resolve("globex");
    expect((await acmeRuntime.repositories.documents.list("owner-acme")).length).toBeGreaterThan(0);
    expect(await acmeRuntime.repositories.documents.list("owner-globex")).toEqual([]);
    expect(
      (await globexRuntime.repositories.documents.list("owner-globex")).length,
    ).toBeGreaterThan(0);
    expect(await globexRuntime.repositories.documents.list("owner-acme")).toEqual([]);
  });

  it("answers 403 when the principal is not a member of the claimed tenant", async () => {
    const response = await postResearch("token-foreign");
    expect(response.status).toBe(403);
    await response.text();
    // Nothing was stored for the refused tenant/owner pair.
    const acmeRuntime = await resolver.resolve("acme");
    expect(await acmeRuntime.repositories.documents.list("owner-globex")).toEqual([]);
  });

  it("still refuses unauthenticated callers with 401", async () => {
    const response = await postResearch(undefined);
    expect(response.status).toBe(401);
    await response.text();
  });
});
