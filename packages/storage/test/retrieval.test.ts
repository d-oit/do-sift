import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Repositories,
  applyMigrations,
  buildMatchQuery,
  extractQueryTokens,
  loadMigrations,
  searchPassages,
} from "../src/index.js";

let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  for (const id of ["owner-a", "owner-b"]) {
    await repos.owners.ensure(id, id);
  }
});

async function insertPassageFor(ownerId: string, excerpt: string): Promise<string> {
  const docId = await repos.documents.insert({
    ownerId,
    canonicalUrl: `https://example.test/${encodeURIComponent(excerpt.slice(0, 12))}`,
    originalUrl: `https://example.test/${encodeURIComponent(excerpt.slice(0, 12))}`,
    contentHash: `hash-${excerpt.length}`,
    fetchedAt: "2026-09-10T00:00:00Z",
    rawText: excerpt,
  });
  return repos.passages.insert({ ownerId, documentId: docId, excerpt, extractionStatus: "ok" });
}

describe("query tokenization (MATCH-injection safety)", () => {
  it("reduces input to quoted plain tokens joined by OR", () => {
    expect(buildMatchQuery('fts5 OR column = * "NEAR(" db; DROP')).toBe(
      '"fts5" OR "column" OR "near" OR "db" OR "drop"',
    );
    expect(buildMatchQuery("don't stop-me now")).toBe('"don\'t" OR "stop-me" OR "now"');
  });

  it("returns null for tokenless input and caps token count", () => {
    expect(buildMatchQuery("?? !! -- **")).toBeNull();
    expect(
      extractQueryTokens(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")),
    ).toHaveLength(24);
  });
});

describe("searchPassages (FTS5 baseline)", () => {
  it("finds matching passages immediately after insert, ranked by relevance", async () => {
    await insertPassageFor(
      "owner-a",
      "libSQL supports FTS5 virtual tables for keyword retrieval over stored passages.",
    );
    await insertPassageFor(
      "owner-a",
      "FTS5 powers the retrieval baseline; FTS5 ranking uses bm25; FTS5 is deterministic.",
    );
    const hits = await searchPassages(client, "owner-a", "fts5 retrieval", 10);
    expect(hits.length).toBe(2);
    // the passage repeating the term more often ranks first (bm25)
    expect(hits[0]?.excerpt).toContain("deterministic");
    expect(hits[0]?.score).toBeLessThanOrEqual(hits[1]?.score ?? 0);
    expect(hits[0]?.documentId).toBeDefined();
  });

  it("never returns another owner's passages (cross-owner negative)", async () => {
    await insertPassageFor(
      "owner-a",
      "Vector search arrives only after beating this keyword baseline.",
    );
    await insertPassageFor(
      "owner-b",
      "Vector search arrives only after beating this keyword baseline.",
    );
    const a = await searchPassages(client, "owner-a", "vector keyword baseline", 10);
    expect(a).toHaveLength(1);
    expect((await repos.passages.get("owner-a", a[0]?.passageId ?? ""))?.ownerId).toBe("owner-a");
    expect(await searchPassages(client, "owner-b", "vector keyword baseline", 10)).toHaveLength(1);
    expect(await searchPassages(client, "owner-c", "vector keyword baseline", 10)).toHaveLength(0);
  });

  it("treats hostile queries as plain words, never MATCH syntax", async () => {
    await insertPassageFor("owner-a", "The passages table holds evidence excerpts for retrieval.");
    for (const hostile of [
      'fts" OR 1=1 --',
      "passages NEAR( evidence )",
      "retrieval* AND (passages)",
      "x: y; z",
    ]) {
      const hits = await searchPassages(client, "owner-a", hostile, 10);
      // every returned hit must genuinely contain one of the query words
      for (const hit of hits) {
        expect(hit.excerpt.toLowerCase()).toMatch(/fts|passages|near|evidence|retrieval|and/u);
      }
    }
  });

  it("respects the limit and returns [] for tokenless queries", async () => {
    for (let i = 0; i < 5; i++) {
      await insertPassageFor(
        "owner-a",
        `Retrieval baseline fixture number ${i} with shared keywords.`,
      );
    }
    expect(await searchPassages(client, "owner-a", "retrieval baseline", 3)).toHaveLength(3);
    expect(await searchPassages(client, "owner-a", "?? -- **", 3)).toEqual([]);
  });
});

describe("evidence relevance floor (SRC-11)", () => {
  /** Local scored seeder: keeps the shared helper untouched for the
   * pre-floor tests (their behavior stays byte-identical). */
  async function insertScoredPassageFor(
    ownerId: string,
    excerpt: string,
    score?: number,
  ): Promise<string> {
    const docId = await repos.documents.insert({
      ownerId,
      canonicalUrl: `https://example.test/${encodeURIComponent(excerpt.slice(0, 12))}`,
      originalUrl: `https://example.test/${encodeURIComponent(excerpt.slice(0, 12))}`,
      contentHash: `scored-${score ?? "none"}-${excerpt.length}`,
      fetchedAt: "2026-09-14T00:00:00Z",
      rawText: excerpt,
      ...(score === undefined ? {} : { relevanceScore: score }),
    });
    return repos.passages.insert({ ownerId, documentId: docId, excerpt, extractionStatus: "ok" });
  }

  it("excludes documents scored below the floor; at-or-above and NULL stay", async () => {
    const low = await insertScoredPassageFor(
      "owner-a",
      "libSQL supports FTS5 virtual tables for keyword retrieval over stored passages.",
      0.5,
    );
    const high = await insertScoredPassageFor(
      "owner-a",
      "FTS5 powers the retrieval baseline; FTS5 ranking uses bm25; FTS5 is deterministic.",
      0.9,
    );
    const legacy = await insertScoredPassageFor(
      "owner-a",
      "Vector search arrives only after beating this keyword baseline.",
      undefined,
    );

    const hits = await searchPassages(client, "owner-a", "fts5 baseline", 10, undefined, 0.7);
    const surfaced = hits.map((h) => h.passageId);
    expect(surfaced).not.toContain(low); // 0.5 < floor 0.70 — advisory-excluded
    expect(surfaced).toContain(high); // 0.9 >= floor
    expect(surfaced).toContain(legacy); // NULL = legacy/unmeasured — always included
  });

  it("stays owner-scoped under the floor: another owner's identical scored doc is invisible", async () => {
    await insertScoredPassageFor(
      "owner-a",
      "FTS5 powers the retrieval baseline; FTS5 ranking uses bm25; FTS5 is deterministic.",
      0.9,
    );
    await insertScoredPassageFor(
      "owner-b",
      "FTS5 powers the retrieval baseline; FTS5 ranking uses bm25; FTS5 is deterministic.",
      0.9,
    );
    const a = await searchPassages(client, "owner-a", "fts5 baseline", 10, undefined, 0.7);
    expect(a).toHaveLength(1);
    expect((await repos.passages.get("owner-a", a[0]?.passageId ?? ""))?.ownerId).toBe("owner-a");
    expect(
      await searchPassages(client, "owner-b", "fts5 baseline", 10, undefined, 0.7),
    ).toHaveLength(1);
  });

  it("is byte-identical when no floor is passed (existing callers unchanged)", async () => {
    const low = await insertScoredPassageFor(
      "owner-a",
      "libSQL supports FTS5 virtual tables for keyword retrieval over stored passages.",
      0.5,
    );
    const hits = await searchPassages(client, "owner-a", "fts5 retrieval", 10);
    expect(hits.map((h) => h.passageId)).toContain(low); // no floor → no filtering
  });
});
