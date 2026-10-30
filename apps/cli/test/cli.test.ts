import { createClient, type Client } from "@libsql/client";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations } from "@do-sift/storage";
import { runCli } from "../src/cli.js";

let client: Client;
let stdout: string[];
let stderr: string[];

function deps(extra: { writeNewFile?: (p: string, c: string) => Promise<void> } = {}) {
  return {
    client,
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
    ...extra,
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  stdout = [];
  stderr = [];
  await client.execute(
    "INSERT INTO owners (id, display_name, created_at) VALUES ('alice','Alice','2026-10-01T00:00:00Z'),('bob','Bob','2026-10-01T00:00:00Z')",
  );
  await client.execute(
    `INSERT INTO requests (id, owner_id, mode, question, status, created_at, completed_at)
     VALUES ('req1','alice','search','What is quantum computing?','completed','2026-10-02T10:00:00Z','2026-10-02T10:00:05Z'),
            ('req2','alice','search','Secret question about nuclear physics?','failed','2026-10-03T10:00:00Z','2026-10-03T10:00:01Z'),
            ('req3','alice','search','Empty results query?','completed','2026-10-04T10:00:00Z','2026-10-04T10:00:02Z'),
            ('req4','bob','search','Bobs private question?','completed','2026-10-02T10:00:00Z','2026-10-02T10:00:05Z')`,
  );
  await client.execute(
    `INSERT INTO documents (id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, raw_text, request_id, relevance_score, created_at)
     VALUES ('d1','alice','https://a.test/x','https://a.test/x?utm=1','h1','2026-10-02T10:00:01Z','Alpha','Secret raw text content','req1',0.85,'2026-10-02T10:00:01Z'),
            ('d2','bob','https://b.test/y','https://b.test/y','h2','2026-10-02T10:00:01Z','Bravo','Bobs raw content','req4',0.90,'2026-10-02T10:00:01Z')`,
  );
  await client.execute(
    `INSERT INTO passages (id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
     VALUES ('p1','alice','d1',NULL,'Alpha excerpt text','ok','2026-10-02T10:00:02Z')`,
  );
  await client.execute(
    `INSERT INTO passage_embeddings (passage_id, owner_id, model_id, vector, created_at)
     VALUES ('p1','alice','m1',X'0001','2026-10-02T10:00:03Z')`,
  );
  await client.execute(
    `INSERT INTO usage_ledger (id, owner_id, request_id, kind, input_tokens, output_tokens, search_calls, fetches, day, state, created_at)
     VALUES ('u1','alice','req1','settlement',100,20,1,2,'2026-10-02','settled','2026-10-02T10:00:05Z'),
            ('u2','alice','req2','settlement',0,0,1,0,'2026-10-03','settled','2026-10-03T10:00:01Z'),
            ('u3','bob','req4','settlement',999,0,1,1,'2026-10-02','settled','2026-10-02T10:00:05Z')`,
  );
});

afterEach(() => {
  client.close();
});

describe("do-sift CLI (#67)", () => {
  it("lists owners", async () => {
    expect(await runCli(["owners", "list"], deps())).toBe(0);
    expect(stdout[0]).toBe("id\tdisplay_name\tcreated_at");
    expect(stdout.join("\n")).toContain("alice\tAlice");
    expect(stdout.join("\n")).toContain("bob\tBob");
  });

  it("summarises one owner's usage for a day, never another owner's", async () => {
    expect(await runCli(["usage", "show", "--owner", "alice", "--day", "2026-10-02"], deps())).toBe(
      0,
    );
    const text = stdout.join("\n");
    expect(text).toContain("settlement\tsettled\t1\t100\t20\t1\t2");
    expect(text).not.toContain("999");
  });

  it("requires --owner and a valid --day for usage", async () => {
    expect(await runCli(["usage", "show", "--day", "2026-10-02"], deps())).toBe(2);
    expect(stderr.join("\n")).toContain("--owner is required");
    expect(await runCli(["usage", "show", "--owner", "alice", "--day", "yesterday"], deps())).toBe(
      2,
    );
  });

  it("lists only the requested owner's evidence and bounds --limit", async () => {
    expect(await runCli(["evidence", "list", "--owner", "bob"], deps())).toBe(0);
    expect(stdout.join("\n")).toContain("d2");
    expect(stdout.join("\n")).not.toContain("d1");
    expect(await runCli(["evidence", "list", "--owner", "bob", "--limit", "0"], deps())).toBe(2);
  });

  it("exports one owner's documents and passages to a new file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "do-sift-cli-"));
    const out = join(dir, "alice.json");
    expect(await runCli(["evidence", "export", "--owner", "alice", "--out", out], deps())).toBe(0);
    const payload = JSON.parse(await readFile(out, "utf8")) as {
      owner: string;
      documents: Array<{ id: string }>;
      passages: Array<{ id: string }>;
    };
    expect(payload.owner).toBe("alice");
    expect(payload.documents.map((d) => d.id)).toEqual(["d1"]);
    expect(payload.passages.map((p) => p.id)).toEqual(["p1"]);
  });

  it("refuses to overwrite an existing export file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "do-sift-cli-"));
    const out = join(dir, "exists.json");
    await writeFile(out, "keep me");
    expect(await runCli(["evidence", "export", "--owner", "alice", "--out", out], deps())).toBe(1);
    expect(await readFile(out, "utf8")).toBe("keep me");
  });

  it("exposes no write, delete, or migrate command", async () => {
    expect(await runCli(["owners", "delete", "--owner", "alice"], deps())).toBe(2);
    expect(await runCli(["migrate"], deps())).toBe(2);
    expect(stderr.join("\n")).toContain("usage: do-sift-cli");
  });

  describe("research list & research show", () => {
    it("lists research runs for one explicit owner and redacts question by default", async () => {
      expect(await runCli(["research", "list", "--owner", "alice"], deps())).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("req1");
      expect(text).toContain("req2");
      expect(text).toContain("req3");
      expect(text).not.toContain("req4"); // Bob's request is isolated
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("What is quantum computing?");
    });

    it("un-redacts question text when --show-question is provided", async () => {
      expect(
        await runCli(["research", "list", "--owner", "alice", "--show-question"], deps()),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("What is quantum computing?");
      expect(text).not.toContain("[REDACTED]");
    });

    it("rejects malformed research list options with exit code 2", async () => {
      expect(
        await runCli(["research", "list", "--owner", "alice", "--limit", "invalid"], deps()),
      ).toBe(2);
      expect(
        await runCli(["research", "list", "--owner", "alice", "--since", "invalid-date"], deps()),
      ).toBe(2);
      expect(
        await runCli(["research", "list", "--owner", "alice", "--until", "invalid-date"], deps()),
      ).toBe(2);
      expect(
        await runCli(
          ["research", "list", "--owner", "alice", "--status", "invalid-status"],
          deps(),
        ),
      ).toBe(2);
    });

    it("filters research runs by status and time range", async () => {
      // Failed runs
      stdout = [];
      expect(
        await runCli(["research", "list", "--owner", "alice", "--status", "failed"], deps()),
      ).toBe(0);
      let text = stdout.join("\n");
      expect(text).toContain("req2");
      expect(text).not.toContain("req1");
      expect(text).not.toContain("req3");

      // Degraded runs (failed or completed with 0 documents)
      stdout = [];
      expect(
        await runCli(["research", "list", "--owner", "alice", "--status", "degraded"], deps()),
      ).toBe(0);
      text = stdout.join("\n");
      expect(text).toContain("req2");
      expect(text).toContain("req3");
      expect(text).not.toContain("req1");

      // Since filter
      stdout = [];
      expect(
        await runCli(["research", "list", "--owner", "alice", "--since", "2026-10-03"], deps()),
      ).toBe(0);
      text = stdout.join("\n");
      expect(text).toContain("req2");
      expect(text).toContain("req3");
      expect(text).not.toContain("req1");

      // Until filter
      stdout = [];
      expect(
        await runCli(["research", "list", "--owner", "alice", "--until", "2026-10-02"], deps()),
      ).toBe(0);
      text = stdout.join("\n");
      expect(text).toContain("req1");
      expect(text).not.toContain("req2");
      expect(text).not.toContain("req3");
    });

    it("shows detailed research run receipt without exposing raw text or passages", async () => {
      expect(
        await runCli(["research", "show", "--owner", "alice", "--request", "req1"], deps()),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("request_id\treq1");
      expect(text).toContain("owner_id\talice");
      expect(text).toContain("status\tcompleted");
      expect(text).toContain("question\t[REDACTED]");
      expect(text).toContain("documents_stored\t1");
      expect(text).toContain("passages_stored\t1");
      expect(text).toContain("embedded_passages\t1");
      expect(text).toContain("search_calls\t1");
      expect(text).toContain("fetches\t2");
      expect(text).toContain("https://a.test/x");
      expect(text).toContain("0.85");
      // Never expose sensitive page text or excerpts
      expect(text).not.toContain("Secret raw text content");
      expect(text).not.toContain("Alpha excerpt text");
    });

    it("shows unredacted question in research show when --show-question is specified", async () => {
      expect(
        await runCli(
          ["research", "show", "--owner", "alice", "--request", "req1", "--show-question"],
          deps(),
        ),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("question\tWhat is quantum computing?");
    });

    it("returns exit code 1 when request ID is not found or belongs to another owner", async () => {
      // Non-existent request
      stdout = [];
      stderr = [];
      expect(
        await runCli(["research", "show", "--owner", "alice", "--request", "nonexistent"], deps()),
      ).toBe(1);
      expect(stderr.join("\n")).toContain("not found for owner alice");

      // Bob's request attempted by alice
      stdout = [];
      stderr = [];
      expect(
        await runCli(["research", "show", "--owner", "alice", "--request", "req4"], deps()),
      ).toBe(1);
      expect(stderr.join("\n")).toContain("not found for owner alice");
    });

    it("exports redacted run receipt JSON using --out", async () => {
      const dir = await mkdtemp(join(tmpdir(), "do-sift-receipt-"));
      const outPath = join(dir, "receipt.json");
      expect(
        await runCli(
          ["research", "show", "--owner", "alice", "--request", "req1", "--out", outPath],
          deps(),
        ),
      ).toBe(0);

      const content = await readFile(outPath, "utf8");
      const json = JSON.parse(content) as {
        request: { id: string; ownerId: string; status: string; question: string };
        counters: { documentsStored: number; passagesStored: number; embeddedPassages: number };
        documents: Array<{ id: string; canonicalUrl: string; relevanceScore: number }>;
      };

      expect(json.request.id).toBe("req1");
      expect(json.request.ownerId).toBe("alice");
      expect(json.request.status).toBe("completed");
      expect(json.request.question).toBe("[REDACTED]");
      expect(json.counters.documentsStored).toBe(1);
      expect(json.counters.passagesStored).toBe(1);
      expect(json.counters.embeddedPassages).toBe(1);
      expect(json.documents[0]?.canonicalUrl).toBe("https://a.test/x");
      expect(json.documents[0]?.relevanceScore).toBe(0.85);

      // Verify raw text and excerpts are not present in exported JSON
      expect(content).not.toContain("Secret raw text content");
      expect(content).not.toContain("Alpha excerpt text");

      // Refuses to overwrite existing export file
      expect(
        await runCli(
          ["research", "show", "--owner", "alice", "--request", "req1", "--out", outPath],
          deps(),
        ),
      ).toBe(1);
    });
  });
});
