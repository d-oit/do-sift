/**
 * SRC-11 offline fixture (plans/003-004-src-ans.md): the spike's 14
 * measured question↔extract pairs frozen so CI sensors judge threshold
 * changes. The recorded whole-extract cosines replay through a keyed
 * fake embedder (unit vectors pairing to the recorded scores) — no
 * ONNX, no network, no live API. Classification at the designed floor
 * 0.70 must replay exactly as recorded: 0/7 correct pages dropped, all
 * 4 clearly-off-topic dopps excluded, the adjacent Q04 family included
 * (this check removes clearly-off-topic pages; it does not fix Q04's
 * F3 problem — disclosed, not solved).
 */
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Repositories,
  applyMigrations,
  hybridSearch,
  loadMigrations,
  searchByEmbedding,
  searchPassages,
  storePassageEmbeddings,
  type TextEmbedder,
} from "../src/index.js";

const PLAYER_QUESTION = "spike question";
const MODEL_ID = "fake-spike-1";
const FLOOR = 0.7;

/** Unit vector pairing to [1, 0] at cosine `score` exactly. */
function vectorFor(score: number): number[] {
  return [score, Math.sqrt(1 - score * score)];
}

interface SpikePair {
  title: string;
  score: number;
}

/** Every excerpt carries the query tokens ("spike", "record") so the
 * bm25 OR-of-tokens half matches all rows — classification then hinges
 * solely on the relevance floor, which is the recorded semantic. */
const CORRECT: SpikePair[] = [
  { title: "World Wide Web", score: 0.837 },
  { title: "History of the WWW", score: 0.8268 },
  { title: "Tim Berners-Lee", score: 0.7375 },
  { title: "Aurora", score: 0.8146 },
  { title: "Peace of Westphalia", score: 0.8531 },
  { title: "Berlin Wall", score: 0.7938 },
  { title: "Fall of the Berlin Wall", score: 0.7803 },
];
/** Adjacent Q04 dopps survive every FP-free rule — included at 0.70. */
const ADJACENT: SpikePair[] = [
  { title: "North Rhine-Westphalia", score: 0.7459 },
  { title: "Westphalia", score: 0.7689 },
  { title: "Westphalian system", score: 0.7917 },
];
/** The 4 clearly-off-topic dopps the absolute threshold drops. */
const OFF_TOPIC: SpikePair[] = [
  { title: "Mike Berners-Lee", score: 0.5303 },
  { title: "What Happened to the Heart?", score: 0.6365 },
  { title: "Aurora (singer)", score: 0.6741 },
  { title: "The Wall – Live in Berlin", score: 0.6534 },
];
const ALL_PAIRS = [...CORRECT, ...ADJACENT, ...OFF_TOPIC];
const INCLUDED_TITLES = [...CORRECT, ...ADJACENT].map((p) => p.title);
const EXCLUDED_TITLES = OFF_TOPIC.map((p) => p.title);
const QUERY = "spike record";

let client: Client;
let repos: Repositories;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  repos = new Repositories(client);
  await repos.owners.ensure("owner-a", "Owner A");
});

/** excerpt = `${title} treaty foot spike record foot` (unique tokens are
 * the title's own words; the shared tokens keep the bm25 half matching). */
function excerptFor(title: string): string {
  return `${title} treaty foot spike record foot`;
}

/** Keyed fake embedder: the question pairs at cosine 1 with [1, 0];
 * each excerpt pairs at exactly its recorded whole-extract cosine. */
function makeSpikeEmbedder(vectors: Record<string, number[]>): TextEmbedder {
  return {
    modelId: MODEL_ID,
    async embedPassages(texts) {
      return texts.map((t) => vectors[t] ?? [0, 0]);
    },
    async embedQuery(text) {
      return vectors[text] ?? [0, 0];
    },
  };
}

/** Seed the frozen pairs: the recorded cosine is the pipeline's stored
 * receipt (relevance_score) AND the paired embedding (the vector half
 * re-derives the same cosine). Plus one legacy row (NULL score —
 * always included). */
async function seedFrozenPairs(): Promise<Map<string, string>> {
  const byTitle = new Map<string, string>();
  const vectors: Record<string, number[]> = { [PLAYER_QUESTION]: [1, 0] };
  const rows: Array<{ passageId: string; ownerId: string; vector: number[] }> = [];
  for (const pair of ALL_PAIRS) {
    const excerpt = excerptFor(pair.title);
    const documentId = await repos.documents.insert({
      ownerId: "owner-a",
      canonicalUrl: `https://spike.test/${pair.title.toLowerCase().replace(/[^a-z]+/gu, "-")}`,
      originalUrl: `https://spike.test/${pair.title.toLowerCase().replace(/[^a-z]+/gu, "-")}`,
      contentHash: `spike-${pair.score}`,
      fetchedAt: "2026-09-14T00:00:00Z",
      rawText: excerpt,
      relevanceScore: pair.score,
    });
    const passageId = await repos.passages.insert({
      ownerId: "owner-a",
      documentId,
      excerpt,
      extractionStatus: "ok",
    });
    byTitle.set(pair.title, passageId);
    vectors[excerpt] = vectorFor(pair.score);
    rows.push({ passageId, ownerId: "owner-a", vector: vectorFor(pair.score) });
  }
  // legacy / unmeasured row: NULL relevance — always included
  const legacyTitle = "Legacy corpus row";
  const legacyExcerpt = excerptFor(legacyTitle);
  const legacyDocumentId = await repos.documents.insert({
    ownerId: "owner-a",
    canonicalUrl: "https://spike.test/legacy-corpus-row",
    originalUrl: "https://spike.test/legacy-corpus-row",
    contentHash: "spike-legacy",
    fetchedAt: "2026-09-14T00:00:00Z",
    rawText: legacyExcerpt,
  });
  const legacyPassageId = await repos.passages.insert({
    ownerId: "owner-a",
    documentId: legacyDocumentId,
    excerpt: legacyExcerpt,
    extractionStatus: "ok",
  });
  byTitle.set(legacyTitle, legacyPassageId);
  vectors[legacyExcerpt] = [1, 0];
  rows.push({ passageId: legacyPassageId, ownerId: "owner-a", vector: [1, 0] });

  await storePassageEmbeddings(client, MODEL_ID, rows);
  return byTitle;
}

describe("SRC-11 designed classification at the floor 0.70", () => {
  let embedder: TextEmbedder;

  beforeEach(async () => {
    await seedFrozenPairs();
    const vectors: Record<string, number[]> = { [PLAYER_QUESTION]: [1, 0] };
    for (const pair of ALL_PAIRS) {
      vectors[excerptFor(pair.title)] = vectorFor(pair.score);
    }
    vectors[excerptFor("Legacy corpus row")] = [1, 0];
    embedder = makeSpikeEmbedder(vectors);
  });

  it("searchPassages replays the recorded classification exactly", async () => {
    const hits = await searchPassages(client, "owner-a", QUERY, 20, undefined, FLOOR);
    const titles = hits.map((h) => h.excerpt.replace(" treaty foot spike record foot", ""));
    for (const title of INCLUDED_TITLES) expect(titles).toContain(title);
    for (const title of EXCLUDED_TITLES) expect(titles).not.toContain(title);
    expect(titles).toContain("Legacy corpus row"); // NULL — always included
    expect(hits).toHaveLength(11); // 10 records + legacy
  });

  it("searchByEmbedding replays the recorded classification exactly", async () => {
    const hits = await searchByEmbedding(client, "owner-a", MODEL_ID, [1, 0], 20, undefined, FLOOR);
    const titles = hits.map((h) => h.excerpt.replace(" treaty foot spike record foot", ""));
    for (const title of INCLUDED_TITLES) expect(titles).toContain(title);
    for (const title of EXCLUDED_TITLES) expect(titles).not.toContain(title);
    expect(titles).toContain("Legacy corpus row");
    expect(hits).toHaveLength(11);
  });

  it("hybridSearch replays the recorded classification exactly (both halves floor-applied)", async () => {
    const fused = await hybridSearch(
      client,
      "owner-a",
      PLAYER_QUESTION,
      20,
      embedder,
      undefined,
      FLOOR,
    );
    const titles = fused.map((h) => h.excerpt.replace(" treaty foot spike record foot", ""));
    for (const title of INCLUDED_TITLES) expect(titles).toContain(title);
    for (const title of EXCLUDED_TITLES) expect(titles).not.toContain(title);
    expect(titles).toContain("Legacy corpus row");
    expect(fused).toHaveLength(11);
  });

  it("replays the recorded boundary pair: lowest included 0.7375, highest excluded 0.6741", async () => {
    const hits = await searchPassages(client, "owner-a", QUERY, 20, undefined, FLOOR);
    const titles = hits.map((h) => h.excerpt.replace(" treaty foot spike record foot", ""));
    expect(titles).toContain("Tim Berners-Lee"); // 0.7375 — the thin margin's included side
    expect(titles).not.toContain("Aurora (singer)"); // 0.6741 — the excluded side (+0.063 margin)
  });

  it("replays the thin margin: any floor in (0.6741, 0.7375) classifies identically", async () => {
    for (const floor of [0.68, 0.7, 0.72]) {
      const hits = await searchPassages(client, "owner-a", QUERY, 20, undefined, floor);
      const titles = hits.map((h) => h.excerpt.replace(" treaty foot spike record foot", ""));
      expect(titles).toContain("Tim Berners-Lee");
      expect(titles).not.toContain("Aurora (singer)");
      expect(hits).toHaveLength(11);
    }
  });
});
