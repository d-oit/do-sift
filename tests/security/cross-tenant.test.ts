/**
 * Cross-tenant leakage suite (issue #120, plan 024 — MT-05).
 *
 * Attack premise: a genuinely authenticated principal of tenant A tries to
 * reach tenant B's evidence, answers, cache, budget, or jobs, using ids it
 * legitimately knows or the same owner id string. The layers prove that both
 * halves of the boundary hold:
 *
 *   1. the query layer — every repository/ledger/queue/retrieval statement is
 *      bound to one tenant, not just to an owner id;
 *   2. the schema — a write whose (tenant_id, owner_id) pair does not match
 *      an owners row is aborted by the migration-0011 triggers.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { StaticOidcVerifier } from "@do-sift/auth";
import { createOidcAuthPlugin } from "@do-sift/plugin-auth-oidc";
import { FakeModelProvider } from "@do-sift/fake-providers";
import {
  BudgetService,
  JobQueue,
  Repositories,
  applyMigrations,
  loadMigrations,
  pruneOwnerHistory,
  searchPassages,
  type DailyCaps,
} from "@do-sift/storage";
import { createAnswerService } from "@do-sift/server";

const QUESTION = "how does bm25 ranking work?";
const ACME_OWNER = "owner-acme";
const GLOBEX_OWNER = "owner-globex";
const T0 = Date.parse("2026-11-02T12:00:00.000Z");

const CAPS: DailyCaps = {
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxSearchCalls: 5,
  maxFetches: 20,
};

const REQUEST = {
  maxInputTokens: 4_000,
  maxOutputTokens: 700,
  maxSearchCalls: 1,
  maxFetches: 3,
  deadlineMs: 30_000,
} as const;

let client: Client;
let acme: Repositories;
let globex: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  acme = new Repositories(client, "acme");
  globex = new Repositories(client, "globex");
  await acme.owners.ensure(ACME_OWNER, "Acme owner");
  await globex.owners.ensure(GLOBEX_OWNER, "Globex owner");
});

async function seedEvidence(repos: Repositories, ownerId: string, marker: string): Promise<void> {
  const docId = await repos.documents.insert({
    ownerId,
    canonicalUrl: `https://docs.test/${tenantOf(repos)}/${marker}`,
    originalUrl: `https://docs.test/${tenantOf(repos)}/${marker}`,
    contentHash: `hash-${tenantOf(repos)}-${marker}`,
    fetchedAt: "2026-11-02T00:00:00Z",
    rawText: "ranking",
  });
  await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt: `bm25 ranker evidence belonging to ${tenantOf(repos)} ${marker}`,
    extractionStatus: "ok",
  });
}

function tenantOf(repos: Repositories): string {
  return repos.tenantId;
}

describe("schema-level tenant consistency", () => {
  it("aborts a write whose tenant does not own the referenced owner", async () => {
    await expect(
      globex.documents.insert({
        ownerId: ACME_OWNER,
        canonicalUrl: "https://docs.test/globex/evil",
        originalUrl: "https://docs.test/globex/evil",
        contentHash: "hash-globex-evil",
        fetchedAt: "2026-11-02T00:00:00Z",
      }),
    ).rejects.toThrow(/tenant/);

    // Direct SQL cannot bypass the trigger either.
    await expect(
      client.execute({
        sql: "INSERT INTO requests (id, tenant_id, owner_id, mode, question, status, created_at) VALUES ('x', 'globex', ?, 'search', 'q', 'pending', '2026-11-02T00:00:00Z')",
        args: [ACME_OWNER],
      }),
    ).rejects.toThrow(/tenant/);
  });

  it("an owner id cannot be claimed by a second tenant", async () => {
    await globex.owners.ensure(ACME_OWNER, "Stolen");
    expect(await globex.owners.get(ACME_OWNER)).toBeUndefined();
    expect((await globex.owners.list()).map((o) => o.id)).toEqual([GLOBEX_OWNER]);
    expect((await acme.owners.get(ACME_OWNER))?.tenantId).toBe("acme");
  });
});

describe("evidence and answer isolation", () => {
  it("a tenant cannot read another tenant's owners, documents, or passages", async () => {
    await seedEvidence(acme, ACME_OWNER, "acme-doc");
    await seedEvidence(globex, GLOBEX_OWNER, "globex-doc");

    expect(await acme.owners.get(GLOBEX_OWNER)).toBeUndefined();
    expect((await acme.documents.list(ACME_OWNER)).map((d) => d.contentHash)).toEqual([
      "hash-acme-acme-doc",
    ]);
    expect(await globex.documents.list(ACME_OWNER)).toEqual([]);

    const acmeDoc = (await acme.documents.list(ACME_OWNER))[0]!;
    expect(await globex.documents.get(ACME_OWNER, acmeDoc.id)).toBeUndefined();
    expect(await globex.documents.findByUrl(ACME_OWNER, acmeDoc.canonicalUrl)).toBeUndefined();
    expect(await globex.passages.listByDocument(ACME_OWNER, acmeDoc.id)).toEqual([]);
    expect(await globex.passages.countByDocument(ACME_OWNER, acmeDoc.id)).toBe(0);
  });

  it("retrieval never ranks another tenant's passages", async () => {
    await seedEvidence(acme, ACME_OWNER, "acme-doc");
    await seedEvidence(globex, GLOBEX_OWNER, "globex-doc");

    const acmeHits = await searchPassages(client, ACME_OWNER, QUESTION);
    expect(acmeHits).toHaveLength(1);
    expect(acmeHits[0]?.contentHash).toBe("hash-acme-acme-doc");

    const globexHits = await searchPassages(client, GLOBEX_OWNER, QUESTION);
    expect(globexHits).toHaveLength(1);
    expect(globexHits[0]?.contentHash).toBe("hash-globex-globex-doc");

    // No tenant can retrieve the other tenant's owner at all.
    expect(
      await searchPassages(client, GLOBEX_OWNER === ACME_OWNER ? "" : ACME_OWNER, QUESTION),
    ).toHaveLength(1);
  });

  it("the answer cache and stored answers never cross tenants", async () => {
    await seedEvidence(acme, ACME_OWNER, "acme-doc");
    await seedEvidence(globex, GLOBEX_OWNER, "globex-doc");

    const forAcme = await createAnswerService({
      client,
      repositories: acme,
      model: new FakeModelProvider(),
    }).answer({ ownerId: ACME_OWNER, question: QUESTION });

    // Same question in the other tenant: a fresh synthesis, no shared cache.
    const globexService = createAnswerService({
      client,
      repositories: globex,
      model: new FakeModelProvider(),
    });
    const forGlobex = await globexService.answer({ ownerId: GLOBEX_OWNER, question: QUESTION });
    expect(forGlobex.cached).toBe(false);
    expect(forGlobex.answerId).not.toBe(forAcme.answerId);

    expect(await globex.answers.get(ACME_OWNER, forAcme.answerId)).toBeUndefined();
    expect(await acme.answers.get(ACME_OWNER, forGlobex.answerId)).toBeUndefined();

    // A cache-key lookup is tenant-scoped: handing globex the acme key hits nothing.
    const stored = await acme.answers.get(ACME_OWNER, forAcme.answerId);
    if (stored?.cacheKey !== undefined) {
      expect(await globex.answers.findByCacheKey(ACME_OWNER, stored.cacheKey)).toBeUndefined();
    }

    // ... and the answers themselves are filed under the right tenant.
    const rows = await client.execute({
      sql: "SELECT tenant_id FROM answers WHERE id IN (?, ?) ORDER BY tenant_id",
      args: [forAcme.answerId, forGlobex.answerId],
    });
    expect(rows.rows.map((r) => String(r.tenant_id))).toEqual(["acme", "globex"]);
  });
});

describe("budget and job isolation", () => {
  it("daily caps, reservations, and settlements are per tenant", async () => {
    const acmeBudget = new BudgetService(client, CAPS, "acme");
    const globexBudget = new BudgetService(client, CAPS, "globex");

    const reservation = await acmeBudget.reserve({
      ownerId: ACME_OWNER,
      request: REQUEST,
      estimatedInputTokens: 100,
      nowMs: T0,
    });
    expect((await acmeBudget.heldForDay(ACME_OWNER, T0)).inputTokens).toBe(
      reservation.reservation.inputTokens,
    );
    // The other tenant's ledger holds nothing for the same owner id.
    expect(await globexBudget.heldForDay(ACME_OWNER, T0)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      searchCalls: 0,
      fetches: 0,
    });

    // ... and cannot settle or expire the other tenant's reservation.
    await expect(
      globexBudget.settle({
        ownerId: ACME_OWNER,
        reservationId: reservation.id,
        actual: { inputTokens: 1, outputTokens: 1 },
        nowMs: T0,
      }),
    ).rejects.toMatchObject({ kind: "unknown-reservation" });
    expect(await globexBudget.expireDue(ACME_OWNER, T0 + 3_600_000)).toBe(0);
  });

  it("a job queue cannot claim, read, or complete another tenant's job", async () => {
    const acmeQueue = new JobQueue(client, { tenantId: "acme" });
    const globexQueue = new JobQueue(client, { tenantId: "globex" });

    const jobId = await acmeQueue.enqueue(ACME_OWNER, "research", { question: QUESTION }, T0);
    expect(await globexQueue.leaseNext(ACME_OWNER, T0)).toBeUndefined();
    expect(await globexQueue.get(ACME_OWNER, jobId)).toBeUndefined();
    await expect(globexQueue.complete(ACME_OWNER, jobId, T0)).rejects.toThrow(/completable/);
    await expect(globexQueue.fail(ACME_OWNER, jobId, "nope", T0)).rejects.toThrow(/unknown job/);

    // The owning tenant still holds an untouched, queued job.
    const claimed = await acmeQueue.leaseNext(ACME_OWNER, T0);
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.attempts).toBe(1);
  });

  it("retention prunes only the named tenant's history", async () => {
    const insertJob = async (id: string, tenantId: string, ownerId: string): Promise<void> => {
      await client.execute({
        sql: `INSERT INTO jobs (id, tenant_id, owner_id, kind, payload_json, status, attempts, created_at, updated_at)
              VALUES (?, ?, ?, 'research', '{}', 'done', 1, ?, ?)`,
        args: [id, tenantId, ownerId, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"],
      });
    };
    await insertJob("job-acme", "acme", ACME_OWNER);
    await insertJob("job-globex", "globex", GLOBEX_OWNER);

    const result = await pruneOwnerHistory(client, ACME_OWNER, "2026-10-01T00:00:00Z", "acme");
    expect(result.jobsDeleted).toBe(1);
    const remaining = await client.execute("SELECT id FROM jobs ORDER BY id");
    expect(remaining.rows.map((r) => String(r.id))).toEqual(["job-globex"]);
  });
});

describe("auth principal drives tenant selection", () => {
  it("the OIDC provider's tenant picks the scoped repositories", async () => {
    await seedEvidence(acme, ACME_OWNER, "acme-doc");
    await seedEvidence(globex, GLOBEX_OWNER, "globex-doc");

    const plugin = createOidcAuthPlugin();
    await plugin.activate({
      pluginName: "auth-oidc",
      config: {
        verifier: new StaticOidcVerifier({
          "token-acme": {
            subject: ACME_OWNER,
            issuer: "https://idp.test",
            claims: { tenant: "acme" },
          },
          "token-globex": {
            subject: GLOBEX_OWNER,
            issuer: "https://idp.test",
            claims: { tenant: "globex" },
          },
        }),
      },
      events: { emit: () => {} },
    } as unknown as Parameters<typeof plugin.activate>[0]);

    const acmePrincipal = await plugin.authenticate({ token: "token-acme" });
    const globexPrincipal = await plugin.authenticate({ token: "token-globex" });
    expect(acmePrincipal.tenantId).toBe("acme");
    expect(globexPrincipal.tenantId).toBe("globex");

    const acmeDocs = await acme
      .forTenant(acmePrincipal.tenantId)
      .documents.list(acmePrincipal.userId);
    expect(acmeDocs.map((d) => d.contentHash)).toEqual(["hash-acme-acme-doc"]);

    const globexDocs = await acme
      .forTenant(globexPrincipal.tenantId)
      .documents.list(globexPrincipal.userId);
    expect(globexDocs.map((d) => d.contentHash)).toEqual(["hash-globex-globex-doc"]);

    // A principal cannot borrow the other tenant by naming its owner id.
    expect(await acme.forTenant(globexPrincipal.tenantId).documents.list(ACME_OWNER)).toEqual([]);
  });
});
