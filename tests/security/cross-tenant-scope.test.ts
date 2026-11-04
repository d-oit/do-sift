/**
 * Cross-tenant leakage suite, part 2 (issue #120, plan 035 — MT-18).
 *
 * Part 1 (`cross-tenant.test.ts`) proves the tenant-bound classes isolate
 * tenants. This file covers the paths that were owner-only or
 * tenant-defaulted before plan 035: the free embedding/retrieval/noise
 * functions that take a raw client, the CLI data surface, and retention.
 *
 * The attack premise is the same: a principal that legitimately holds a
 * token for tenant A names an owner id from tenant B. Because every entry
 * point now takes an explicit tenant scope *in addition to* deriving the
 * tenant from the owners row, the two must agree before a row is returned.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/cli.js";
import {
  Repositories,
  applyMigrations,
  backfillPassageEmbeddings,
  backfillPassageNoiseClasses,
  getExistingModelDimension,
  hybridSearch,
  loadMigrations,
  searchByEmbedding,
  searchPassages,
  storePassageEmbeddings,
  type PassageNoiseClass,
} from "@do-sift/storage";

const ACME_OWNER = "owner-acme";
const GLOBEX_OWNER = "owner-globex";
const QUESTION = "how does bm25 ranking work?";

let client: Client;
let acme: Repositories;
let globex: Repositories;
let acmePassageId: string;

async function embedQueryOnly(text: string): Promise<number[]> {
  return text === QUESTION ? [1, 0] : [0, 1];
}

const EMBEDDER = {
  modelId: "fake-embed-1",
  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  },
  embedQuery: embedQueryOnly,
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  acme = new Repositories(client, "acme");
  globex = new Repositories(client, "globex");
  await acme.owners.ensure(ACME_OWNER, "Acme owner");
  await globex.owners.ensure(GLOBEX_OWNER, "Globex owner");

  const doc = await acme.documents.insert({
    ownerId: ACME_OWNER,
    canonicalUrl: "https://docs.test/acme",
    originalUrl: "https://docs.test/acme",
    contentHash: "hash-acme",
    fetchedAt: "2026-11-02T00:00:00Z",
    rawText: "bm25 ranking",
  });
  acmePassageId = await acme.passages.insert({
    ownerId: ACME_OWNER,
    documentId: doc,
    excerpt: "bm25 ranker evidence belonging to acme",
    extractionStatus: "ok",
  });
});

describe("retrieval entry points require the caller's tenant to match the owner's", () => {
  it("searchPassages returns nothing under the wrong tenant scope", async () => {
    expect(
      await searchPassages(
        client,
        ACME_OWNER,
        QUESTION,
        10,
        undefined,
        undefined,
        undefined,
        "acme",
      ),
    ).toHaveLength(1);
    expect(
      await searchPassages(
        client,
        ACME_OWNER,
        QUESTION,
        10,
        undefined,
        undefined,
        undefined,
        "globex",
      ),
    ).toEqual([]);
  });

  it("searchByEmbedding returns nothing under the wrong tenant scope", async () => {
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: acmePassageId, ownerId: ACME_OWNER, vector: [1, 0], tenantId: "acme" },
    ]);
    const scoped = (tenant: string) => [tenant] as const;
    expect(
      await searchByEmbedding(
        client,
        ACME_OWNER,
        "fake-embed-1",
        [1, 0],
        10,
        undefined,
        undefined,
        undefined,
        ...scoped("acme"),
      ),
    ).toHaveLength(1);
    expect(
      await searchByEmbedding(
        client,
        ACME_OWNER,
        "fake-embed-1",
        [1, 0],
        10,
        undefined,
        undefined,
        undefined,
        ...scoped("globex"),
      ),
    ).toEqual([]);
  });

  it("hybridSearch returns nothing under the wrong tenant scope", async () => {
    await backfillPassageEmbeddings(client, ACME_OWNER, EMBEDDER, { tenantId: "acme" });
    const theirs = await hybridSearch(
      client,
      ACME_OWNER,
      QUESTION,
      5,
      EMBEDDER,
      undefined,
      undefined,
      undefined,
      "acme",
    );
    expect(theirs.length).toBeGreaterThan(0);
    expect(
      await hybridSearch(
        client,
        ACME_OWNER,
        QUESTION,
        5,
        EMBEDDER,
        undefined,
        undefined,
        undefined,
        "globex",
      ),
    ).toEqual([]);
  });

  it("the embedding dimension is learned only from the scoped tenant's rows", async () => {
    const dims = [1, 0, 0, 0];
    await storePassageEmbeddings(client, "fake-embed-1", [
      { passageId: acmePassageId, ownerId: ACME_OWNER, vector: dims, tenantId: "acme" },
    ]);
    // Acme sees its own 4-wide vectors; globex may not couple to them.
    expect(await getExistingModelDimension(client, "fake-embed-1", ACME_OWNER, "acme")).toBe(4);
    expect(await getExistingModelDimension(client, "fake-embed-1", GLOBEX_OWNER, "globex")).toBe(
      undefined,
    );
  });

  it("an embedding write names the tenant and is refused when it disagrees with the owner", async () => {
    await expect(
      storePassageEmbeddings(client, "fake-embed-1", [
        { passageId: acmePassageId, ownerId: ACME_OWNER, vector: [1, 0], tenantId: "globex" },
      ]),
    ).rejects.toThrow(/tenant/u);
  });

  it("the noise backfill is tenant-scoped, not just owner-scoped", async () => {
    const classify = (text: string): PassageNoiseClass | undefined =>
      text.includes("ranker") ? "nav-list" : undefined;
    expect(await backfillPassageNoiseClasses(client, ACME_OWNER, classify, "globex")).toBe(0);
    expect(await backfillPassageNoiseClasses(client, ACME_OWNER, classify, "acme")).toBe(1);
  });
});

describe("the CLI data surface is tenant-scoped", () => {
  function deps() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      deps: {
        client,
        out: (line: string) => stdout.push(line),
        err: (line: string) => stderr.push(line),
      },
    };
  }

  it("evidence list does not show another tenant's documents for the same owner id", async () => {
    const globexDoc = await globex.documents.insert({
      ownerId: GLOBEX_OWNER,
      canonicalUrl: "https://docs.test/globex",
      originalUrl: "https://docs.test/globex",
      contentHash: "hash-globex",
      fetchedAt: "2026-11-02T00:00:00Z",
    });
    const run = deps();
    expect(
      await runCli(["evidence", "list", "--owner", ACME_OWNER, "--tenant", "globex"], run.deps),
    ).toBe(0);
    expect(run.stdout.join("\n")).not.toContain(acmePassageId);
    expect(run.stdout.join("\n")).not.toContain("docs.test/acme");

    const own = deps();
    expect(
      await runCli(["evidence", "list", "--owner", ACME_OWNER, "--tenant", "acme"], own.deps),
    ).toBe(0);
    expect(own.stdout.join("\n")).toContain("docs.test/acme");

    // The other tenant's row is still reachable, but only under its own
    // tenant scope and owner id.
    const other = deps();
    expect(
      await runCli(["evidence", "list", "--owner", GLOBEX_OWNER, "--tenant", "globex"], other.deps),
    ).toBe(0);
    expect(other.stdout.join("\n")).toContain(globexDoc);
  });

  it("owners list is scoped to one tenant instead of listing every tenant", async () => {
    const run = deps();
    expect(await runCli(["owners", "list", "--tenant", "acme"], run.deps)).toBe(0);
    const text = run.stdout.join("\n");
    expect(text).toContain(ACME_OWNER);
    expect(text).not.toContain(GLOBEX_OWNER);
  });

  it("usage show, research list, and research show honour --tenant", async () => {
    const requestId = "00000000-0000-4000-8000-000000000001";
    await client.execute({
      sql: "INSERT INTO requests (id, tenant_id, owner_id, mode, question, status, created_at) VALUES (?, 'globex', ?, 'search', ?, 'completed', '2026-11-02T00:00:00Z')",
      args: [requestId, GLOBEX_OWNER, QUESTION],
    });

    const usage = deps();
    expect(
      await runCli(
        ["usage", "show", "--owner", GLOBEX_OWNER, "--day", "2026-11-02", "--tenant", "acme"],
        usage.deps,
      ),
    ).toBe(0);
    expect(usage.stdout).toHaveLength(1); // header only: no ledger rows in acme

    const list = deps();
    expect(
      await runCli(["research", "list", "--owner", GLOBEX_OWNER, "--tenant", "acme"], list.deps),
    ).toBe(0);
    expect(list.stdout.join("\n")).not.toContain(requestId);

    const show = deps();
    expect(
      await runCli(
        ["research", "show", "--owner", GLOBEX_OWNER, "--request", requestId, "--tenant", "acme"],
        show.deps,
      ),
    ).toBe(1); // not found in the named tenant
    expect(show.stderr.join("\n")).toContain("not found");

    const own = deps();
    expect(
      await runCli(
        ["research", "show", "--owner", GLOBEX_OWNER, "--request", requestId, "--tenant", "globex"],
        own.deps,
      ),
    ).toBe(0);
    expect(own.stdout.join("\n")).toContain(requestId);
  });

  it("retention prune deletes in the named tenant, not always the default one", async () => {
    for (const [id, tenant, owner] of [
      ["job-default", "default", "owner-default"],
      ["job-globex", "globex", GLOBEX_OWNER],
    ] as const) {
      if (tenant === "default") {
        await new Repositories(client).owners.ensure(owner, owner);
      }
      await client.execute({
        sql: `INSERT INTO jobs (id, tenant_id, owner_id, kind, payload_json, status, attempts, created_at, updated_at)
              VALUES (?, ?, ?, 'research', '{}', 'done', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [id, tenant, owner],
      });
    }
    const run = deps();
    expect(
      await runCli(
        [
          "retention",
          "prune",
          "--owner",
          GLOBEX_OWNER,
          "--tenant",
          "globex",
          "--cutoff",
          "2026-10-01T00:00:00Z",
          "--confirm",
        ],
        { ...run.deps, now: new Date("2026-11-03T12:00:00.000Z") },
      ),
    ).toBe(0);
    const remaining = await client.execute("SELECT id FROM jobs ORDER BY id");
    expect(remaining.rows.map((r) => String(r.id))).toEqual(["job-default"]);
  });
});
