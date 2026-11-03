/**
 * Role policy at the HTTP boundary (issue #120, plan 024 — MT-12): a viewer is
 * read-only, so the run surfaces answer 403 before a runtime is resolved, any
 * budget is reserved, or any evidence is written. A member and an owner may
 * run; a caller with no membership may not. Without `roleFor` the server keeps
 * its pre-MT-12 behavior (single-tenant allowlist posture).
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@do-sift/auth";
import type { TenantRole } from "@do-sift/contracts";
import { createResearchServer, listen, type ResearchServerOptions } from "../src/index.js";

const TOKENS: Record<string, { ownerId: string; tenantId: string }> = {
  "token-viewer": { ownerId: "viewer-acme", tenantId: "acme" },
  "token-member": { ownerId: "member-acme", tenantId: "acme" },
  "token-owner": { ownerId: "owner-acme", tenantId: "acme" },
  "token-stranger": { ownerId: "stranger", tenantId: "acme" },
};

const ROLES: Record<string, TenantRole> = {
  "acme/viewer-acme": "viewer",
  "acme/member-acme": "member",
  "acme/owner-acme": "owner",
};

let server: Server;
let port: number;
let legacyServer: Server;
let legacyPort: number;
const runs: string[] = [];
const answered: string[] = [];

const auth: ResearchServerOptions["auth"] = {
  authenticateOwner: async ({ token }) => {
    const principal = token === undefined ? undefined : TOKENS[token];
    if (principal === undefined) throw new AuthError("invalid-token", "no usable token");
    return { ownerId: principal.ownerId, via: "oidc", tenantId: principal.tenantId };
  },
};

const runResearch: ResearchServerOptions["runResearch"] = async (ownerId) => {
  runs.push(ownerId);
  return {
    hits: 0,
    documentsStored: 0,
    passagesStored: 0,
    denied: 0,
    fetchErrors: 0,
    skippedBudget: 0,
  };
};

const answer: ResearchServerOptions["answer"] = async (ownerId) => {
  answered.push(ownerId);
  return {
    requestId: "req-role-1",
    answerId: "ans-role-1",
    cached: false,
    degraded: false,
    evidenceOnly: false,
    blocks: [],
  };
};

const roleFor: ResearchServerOptions["roleFor"] = (principal) =>
  Promise.resolve(ROLES[`${principal.tenantId}/${principal.userId}`]);

beforeAll(async () => {
  server = createResearchServer({ auth, runResearch, answer, roleFor });
  port = await listen(server);
  legacyServer = createResearchServer({ auth, runResearch });
  legacyPort = await listen(legacyServer);
});

afterAll(() => {
  server.close();
  legacyServer.close();
});

async function ask(path: string, token: string, base = port): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "what is alpha?" }),
  });
  await response.text();
  return response.status;
}

describe("role policy on the run surfaces (MT-12)", () => {
  it("refuses a viewer before any work happens", async () => {
    expect(await ask("/api/research", "token-viewer")).toBe(403);
    expect(await ask("/api/answer", "token-viewer")).toBe(403);
    expect(runs).toEqual([]);
    expect(answered).toEqual([]);
  });

  it("refuses a caller with no recorded membership", async () => {
    expect(await ask("/api/research", "token-stranger")).toBe(403);
  });

  it("lets a member run research and answers", async () => {
    expect(await ask("/api/research", "token-member")).toBe(200);
    expect(await ask("/api/answer", "token-member")).toBe(200);
    expect(runs).toEqual(["member-acme"]);
    expect(answered).toEqual(["member-acme"]);
  });

  it("lets an owner run research", async () => {
    expect(await ask("/api/research", "token-owner")).toBe(200);
    expect(runs).toEqual(["member-acme", "owner-acme"]);
  });

  it("keeps pre-MT-12 behavior when no role source is configured", async () => {
    expect(await ask("/api/research", "token-viewer", legacyPort)).toBe(200);
    expect(runs).toEqual(["member-acme", "owner-acme", "viewer-acme"]);
  });

  it("still refuses an unauthenticated caller", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "what is alpha?" }),
    });
    await response.text();
    expect(response.status).toBe(401);
  });
});
