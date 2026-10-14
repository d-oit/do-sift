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
    `INSERT INTO documents (id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, created_at)
     VALUES ('d1','alice','https://a.test/x','https://a.test/x?utm=1','h1','2026-10-02T00:00:00Z','Alpha','2026-10-02T00:00:00Z'),
            ('d2','bob','https://b.test/y','https://b.test/y','h2','2026-10-02T00:00:00Z','Bravo','2026-10-02T00:00:00Z')`,
  );
  await client.execute(
    `INSERT INTO passages (id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
     VALUES ('p1','alice','d1',NULL,'Alpha excerpt','ok','2026-10-02T00:00:00Z')`,
  );
  await client.execute(
    `INSERT INTO usage_ledger (id, owner_id, request_id, kind, input_tokens, output_tokens, search_calls, fetches, day, state, created_at)
     VALUES ('u1','alice',NULL,'settlement',100,20,1,3,'2026-10-02','settled','2026-10-02T00:00:00Z'),
            ('u2','alice',NULL,'settlement',50,10,0,1,'2026-10-02','settled','2026-10-02T00:00:00Z'),
            ('u3','bob',NULL,'reservation',999,0,0,0,'2026-10-02','open','2026-10-02T00:00:00Z')`,
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
    expect(text).toContain("settlement\tsettled\t2\t150\t30\t1\t4");
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
});
