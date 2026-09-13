/**
 * Consolidated cross-owner negatives (CORE-10): the full composition —
 * auth front door → answer service → owner-scoped repositories. Attack
 * premise: a second, legitimately-authenticated principal (or an attacker
 * with no credentials) tries to reach another owner's evidence, answers,
 * or cache. The per-layer suites prove the layers; these prove the seams.
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService, StaticOidcVerifier, type VerifiedIdentity } from "@do-sift/auth";
import { FakeModelProvider } from "@do-sift/fake-providers";
import { BudgetService, Repositories, applyMigrations, loadMigrations } from "@do-sift/storage";
import { createAnswerService } from "@do-sift/server";

const QUESTION = "how does bm25 ranking work?";

const ALICE: VerifiedIdentity = {
  subject: "owner-alice",
  issuer: "https://stub-issuer.test",
  claims: {},
};
const BOB: VerifiedIdentity = {
  subject: "owner-bob",
  issuer: "https://stub-issuer.test",
  claims: {},
};

let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  for (const id of ["owner-alice", "owner-bob"]) {
    await repos.owners.ensure(id, id);
  }
});

function auth(): AuthService {
  return new AuthService(new StaticOidcVerifier({ "token-alice": ALICE, "token-bob": BOB }), {
    allowlist: ["owner-alice", "owner-bob"],
    devBypass: false,
  });
}

async function seedEvidenceFor(ownerId: string): Promise<void> {
  const docId = await repos.documents.insert({
    ownerId,
    canonicalUrl: `https://docs.test/${ownerId}`,
    originalUrl: `https://docs.test/${ownerId}`,
    contentHash: `hash-${ownerId}-00000001`,
    fetchedAt: "2026-09-11T00:00:00Z",
    rawText: "ranking",
  });
  await repos.passages.insert({
    ownerId,
    documentId: docId,
    excerpt: "bm25 ranks keyword matches; rarer terms weigh more for this owner's documents.",
    extractionStatus: "ok",
  });
}

describe("front door (auth)", () => {
  it("refuses verified subjects outside the allowlist before anything else runs", async () => {
    const mallory: VerifiedIdentity = {
      subject: "owner-mallory",
      issuer: "https://stub-issuer.test",
      claims: {},
    };
    const svc = new AuthService(new StaticOidcVerifier({ "token-mallory": mallory }), {
      allowlist: ["owner-alice", "owner-bob"],
      devBypass: false,
    });
    await expect(svc.authenticateOwner({ token: "token-mallory" })).rejects.toMatchObject({
      kind: "not-allowlisted",
    });
  });

  it("dev bypass is structurally off: a loopback address without a token is refused", async () => {
    await expect(auth().authenticateOwner({ clientAddress: "127.0.0.1" })).rejects.toMatchObject({
      kind: "authentication-required",
    });
  });
});

describe("answer path isolation", () => {
  it("identical questions produce isolated answers per owner; cache never crosses", async () => {
    await seedEvidenceFor("owner-alice");
    await seedEvidenceFor("owner-bob");
    const model = new FakeModelProvider();
    const answerSvc = createAnswerService({
      client,
      repositories: repos,
      model,
      budget: new BudgetService(client, {
        maxInputTokens: 50_000,
        maxOutputTokens: 50_000,
        maxSearchCalls: 100,
        maxFetches: 100,
      }),
    });

    const forAlice = await answerSvc.answer({
      ownerId: (await auth().authenticateOwner({ token: "token-alice" })).ownerId,
      question: QUESTION,
    });
    const forBob = await answerSvc.answer({
      ownerId: (await auth().authenticateOwner({ token: "token-bob" })).ownerId,
      question: QUESTION,
    });
    expect(forAlice.cached).toBe(false);
    expect(forBob.cached).toBe(false); // same question, different owner: NO shared cache
    expect(forAlice.answerId).not.toBe(forBob.answerId);
    expect(model.calls).toHaveLength(2);

    // each answer's citations resolve only within its owner's evidence
    for (const [ownerId, outcome] of [
      ["owner-alice", forAlice],
      ["owner-bob", forBob],
    ] as const) {
      const answer = await repos.answers.get(ownerId, outcome.answerId);
      expect(answer).toBeDefined();
      // the other owner cannot read this answer
      const other = ownerId === "owner-alice" ? "owner-bob" : "owner-alice";
      expect(await repos.answers.get(other, outcome.answerId)).toBeUndefined();
    }
  });

  it("an authenticated owner cannot retrieve, cache-hit, or list another owner's evidence", async () => {
    await seedEvidenceFor("owner-alice");
    const model = new FakeModelProvider();
    await createAnswerService({
      client,
      repositories: repos,
      model,
    }).answer({ ownerId: "owner-alice", question: QUESTION });

    const bob = (await auth().authenticateOwner({ token: "token-bob" })).ownerId;
    // bob's answer on the same question sees none of alice's evidence
    const forBob = await createAnswerService({ client, repositories: repos, model }).answer({
      ownerId: bob,
      question: QUESTION,
    });
    expect(forBob.evidenceOnly).toBe(true); // no evidence → no synthesis, no borrowed claims
    const bobAnswer = await repos.answers.get(bob, forBob.answerId);
    expect(bobAnswer?.blocks).toHaveLength(0);

    // raw repository access is owner-scoped too
    const aliceDocs = await repos.documents.list("owner-alice");
    expect(aliceDocs).toHaveLength(1);
    expect(await repos.documents.get(bob, aliceDocs[0]?.id ?? "")).toBeUndefined();
    expect(await repos.documents.list(bob)).toHaveLength(0);
  });
});
