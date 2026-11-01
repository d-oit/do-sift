/**
 * Cross-tenant leakage gate (#120). Quality-gate test: a principal that is
 * validly authenticated in tenant B must not be able to read, cite, cache-hit,
 * link to, or gain capabilities over tenant-A evidence — even when it holds
 * the exact tenant-A owner id (the owner scope alone would allow it).
 *
 * Composition under test: auth provider → tenant-scoped repositories →
 * answer service → kernel capability grants.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { AllowlistAuthProvider, AuthService, StaticOidcVerifier } from "@do-sift/auth";
import type { Principal } from "@do-sift/contracts";
import { FakeModelProvider } from "@do-sift/fake-providers";
import { CapabilityError, Kernel, type PluginFactory } from "@do-sift/kernel";
import { Repositories, applyMigrations, loadMigrations, searchPassages } from "@do-sift/storage";
import { createAnswerService } from "@do-sift/server";

const QUESTION = "how does bm25 ranking work?";
const ACME = "tenant-acme";
const GLOBEX = "tenant-globex";
/** Deliberately the same owner id in both tenants. */
const OWNER = "owner-shared";

let client: Client;

const verifier = () =>
  new StaticOidcVerifier(
    {
      "token-acme": {
        subject: OWNER,
        issuer: "https://stub-issuer.test",
        claims: { tenant_id: ACME },
      },
      "token-globex": {
        subject: OWNER,
        issuer: "https://stub-issuer.test",
        claims: { tenant_id: GLOBEX },
      },
    },
    "https://stub-issuer.test",
  );

const provider = (): AllowlistAuthProvider =>
  new AllowlistAuthProvider(
    new AuthService(verifier(), {
      allowlist: [OWNER],
      devBypass: false,
      tenantClaim: "tenant_id",
    }),
  );

async function principalFor(token: string): Promise<Principal> {
  return provider().authenticate({ token });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
});

async function seedAcmeEvidence(acme: Repositories): Promise<{ docId: string; passageId: string }> {
  await acme.owners.ensure(OWNER, "Shared Owner");
  const requestId = await acme.requests.create(OWNER, "answer", QUESTION);
  const docId = await acme.documents.insert({
    ownerId: OWNER,
    canonicalUrl: "https://acme.test/bm25",
    originalUrl: "https://acme.test/bm25",
    contentHash: "hash-acme-00000001",
    fetchedAt: "2026-11-01T00:00:00Z",
    rawText: "bm25 ranking internals of the acme corpus",
    requestId,
  });
  const passageId = await acme.passages.insert({
    ownerId: OWNER,
    documentId: docId,
    excerpt: "bm25 ranking weighs rare terms; acme's corpus is the only source here.",
    extractionStatus: "ok",
  });
  await acme.requests.complete(OWNER, requestId);
  return { docId, passageId };
}

describe("cross-tenant isolation", () => {
  it("resolves distinct tenant scopes from the same owner id", async () => {
    const acme = await principalFor("token-acme");
    const globex = await principalFor("token-globex");
    expect(acme).toMatchObject({ tenantId: ACME, ownerId: OWNER });
    expect(globex).toMatchObject({ tenantId: GLOBEX, ownerId: OWNER });
    expect(acme.tenantId).not.toBe(globex.tenantId);
  });

  it("hides another tenant's evidence from reads, listings, and FTS retrieval", async () => {
    const acme = new Repositories(client, { tenantId: ACME });
    const globex = new Repositories(client, { tenantId: GLOBEX });
    const { docId, passageId } = await seedAcmeEvidence(acme);

    expect(await globex.documents.get(OWNER, docId)).toBeUndefined();
    expect(await globex.passages.get(OWNER, passageId)).toBeUndefined();
    expect(await globex.documents.list(OWNER)).toEqual([]);
    const hits = await searchPassages(
      client,
      OWNER,
      "bm25 ranking corpus",
      10,
      undefined,
      undefined,
      undefined,
      GLOBEX,
    );
    expect(hits).toEqual([]);
    // ...while the owning tenant still retrieves it
    const own = await searchPassages(
      client,
      OWNER,
      "bm25 ranking corpus",
      10,
      undefined,
      undefined,
      undefined,
      ACME,
    );
    expect(own.length).toBeGreaterThan(0);
  });

  it("cannot cite, cache-hit, or write into another tenant through the answer path", async () => {
    const acme = new Repositories(client, { tenantId: ACME });
    const globex = new Repositories(client, { tenantId: GLOBEX });
    const { passageId } = await seedAcmeEvidence(acme);

    const model = new FakeModelProvider();
    const acmeAnswer = await createAnswerService({
      client,
      repositories: acme,
      model,
    }).answer({ ownerId: OWNER, question: QUESTION });
    expect(acmeAnswer.cached).toBe(false);

    const globexAnswer = await createAnswerService({
      client,
      repositories: globex,
      model,
    }).answer({ ownerId: OWNER, question: QUESTION });
    // identical owner + question + source versions, different tenant: no
    // shared cache, and no tenant-A citation may cross the boundary.
    expect(globexAnswer.cached).toBe(false);
    expect(globexAnswer.answerId).not.toBe(acmeAnswer.answerId);
    expect(await globex.answers.get(OWNER, acmeAnswer.answerId)).toBeUndefined();
    const acmeRow = await acme.answers.get(OWNER, acmeAnswer.answerId);
    const cited = acmeRow?.blocks.flatMap((block) => block.citations) ?? [];
    expect(cited).toContain(passageId);
    const globexRow = await globex.answers.get(OWNER, globexAnswer.answerId);
    const globexCited = globexRow?.blocks.flatMap((block) => block.citations) ?? [];
    expect(globexCited).not.toContain(passageId);

    await expect(
      globex.answers.insert({
        ownerId: OWNER,
        requestId: acmeRow?.requestId ?? "missing",
        blocks: [{ kind: "paragraph", text: "stolen", citations: [passageId] }],
        evidenceOnly: true,
      }),
    ).rejects.toThrow(/not owned by/);
  });

  it("does not leak capabilities across tenants", async () => {
    const kernel = new Kernel("local");
    const factory: PluginFactory = () => ({ activate() {}, deactivate() {} });
    kernel.register(
      {
        name: "tenant-paid-tool",
        version: "0.1.0",
        apiVersion: "1",
        kind: "model",
        capabilities: ["paid"],
        permissions: { networkHosts: [], secrets: [] },
        config: {},
        entry: "./src/index.js",
        description: "grant-required tool scoped to one tenant",
      },
      factory,
    );
    kernel.grantScoped({ tenantId: ACME }, "tenant-paid-tool", "paid");

    const acme = await principalFor("token-acme");
    const globex = await principalFor("token-globex");
    await expect(kernel.activate("tenant-paid-tool", { principal: globex })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(kernel.activate("tenant-paid-tool", { principal: acme })).resolves.toBeUndefined();
  });
});
