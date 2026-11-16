/**
 * Tenant-scope required guard (issue #159).
 *
 * Prevents reintroducing optional tenant scope on covered storage entry
 * points. Two layers:
 *
 * 1. Static: the public tenant-aware signatures must not declare an
 *    optional `tenantId?`. A regression that makes the scope omittable
 *    fails here before it can ship.
 * 2. Runtime: calling without a scope (via JS `undefined`) fails closed
 *    instead of running an unscoped query.
 *
 * Global surfaces are explicitly documented and tested as global:
 * tenants.ensure/get (registry), applyMigrations/backupToFile/verifyRestore
 * (whole DB), metrics (deployment-global), and pure helpers
 * (extractQueryTokens/buildMatchQuery, vector validation, cosine, rrfFuse,
 * retention cutoff math). They never return tenant data on behalf of a
 * principal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
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
} from "@do-sift/storage";

const ROOT = process.cwd();
function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("tenant scope is required in the static API surface", () => {
  it("retrieval entry points do not declare an optional tenantId", () => {
    const retrieval = src("packages/storage/src/retrieval.ts");
    expect(retrieval).not.toMatch(/tenantId\?:/);
    expect(retrieval).toMatch(/tenantId: string/);
    expect(retrieval).toContain("assertTenantScope");
  });

  it("embedding entry points require tenant scope (types + no unscoped SQL)", () => {
    const embeddings = src("packages/storage/src/embeddings.ts");
    expect(embeddings).not.toMatch(/tenantId\?: string/);
    expect(embeddings).toContain("EmbeddingRowInput");
    expect(embeddings).toContain("tenantId: string;");
    expect(embeddings).toContain("assertTenantScope");
    // No fallback fragments that omit the tenant predicate.
    expect(embeddings).not.toMatch(/tenantId === undefined \? ""/);
    expect(embeddings).not.toMatch(/\.\.\.\(tenantId === undefined/);
    expect(embeddings).not.toMatch(/\.\.\.\(scope === undefined/);
  });

  it("noise backfill requires tenant scope", () => {
    const noise = src("packages/storage/src/noise.ts");
    expect(noise).not.toMatch(/tenantId\?:/);
    expect(noise).toContain("tenantId: string");
    expect(noise).toContain("assertTenantScope");
  });

  it("retention requires tenant scope and has no default fallback", () => {
    const retention = src("packages/storage/src/retention.ts");
    expect(retention).not.toMatch(/tenantId\?: string/);
    expect(retention).toContain("tenantId: string;");
    expect(retention).toContain("assertTenantScope");
    expect(retention).not.toContain("?? DEFAULT_TENANT_ID");
    expect(retention).not.toContain("= DEFAULT_TENANT_ID");
  });

  it("global surfaces stay global and are documented as such", () => {
    // Registry + whole-DB operations take no tenant scope by design.
    const repos = src("packages/storage/src/repositories.ts");
    expect(repos).toContain("tenants =");
    const backup = src("packages/storage/src/backup.ts");
    expect(backup).toContain("backupToFile");
    expect(backup).not.toContain("tenantId");
    const docs = src("docs/multi-tenant-auth.md");
    expect(docs).toMatch(/Global surfaces/i);
  });
});

describe("tenant scope fails closed at runtime", () => {
  it("unscoped retrieval throws instead of querying", async () => {
    const client = createClient({ url: ":memory:" });
    await applyMigrations(client, loadMigrations("migrations"));
    const repos = new Repositories(client, "default");
    await repos.owners.ensure("owner-a", "Owner A");
    // @ts-expect-error — JS caller omits the required scope.
    await expect(
      searchPassages(client, "owner-a", "hello", 10, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/tenant scope is required/i);
    // @ts-expect-error — JS caller omits the required scope.
    await expect(
      searchByEmbedding(
        client,
        "owner-a",
        "m",
        [1, 0],
        10,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/tenant scope is required/i);
    // @ts-expect-error — JS caller omits the required scope.
    await expect(getExistingModelDimension(client, "m", "owner-a", undefined)).rejects.toThrow(
      /tenant scope is required/i,
    );
  });

  it("unscoped writes and backfills throw instead of defaulting", async () => {
    const client = createClient({ url: ":memory:" });
    await applyMigrations(client, loadMigrations("migrations"));
    const repos = new Repositories(client, "default");
    await repos.owners.ensure("owner-a", "Owner A");
    const doc = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: "https://example.test/a",
      originalUrl: "https://example.test/a",
      contentHash: "hash-a",
      fetchedAt: "2026-11-15T00:00:00Z",
      rawText: "hello",
    });
    const passage = await repos.passages.insert({
      ownerId: "owner-a",
      documentId: doc,
      excerpt: "hello world",
      extractionStatus: "ok",
    });
    // @ts-expect-error — missing tenantId in row input.
    await expect(
      storePassageEmbeddings(client, "m", [
        { passageId: passage, ownerId: "owner-a", vector: [1, 0] },
      ]),
    ).rejects.toThrow(/tenant scope is required/i);
    const embedder = {
      modelId: "m",
      embedPassages: async (t: string[]) => t.map(() => [1, 0]),
      embedQuery: async () => [1, 0],
    };
    // @ts-expect-error — missing tenant scope option.
    await expect(backfillPassageEmbeddings(client, "owner-a", embedder, {})).rejects.toThrow(
      /tenant scope is required/i,
    );
    // @ts-expect-error — missing tenant scope arg.
    await expect(
      backfillPassageNoiseClasses(client, "owner-a", () => undefined, undefined),
    ).rejects.toThrow(/tenant scope is required/i);
    // @ts-expect-error — hybrid without scope.
    await expect(
      hybridSearch(
        client,
        "owner-a",
        "hello",
        5,
        embedder,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/tenant scope is required/i);
  });
});
