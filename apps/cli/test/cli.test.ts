import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repositories, applyMigrations, loadMigrations } from "@do-sift/storage";
import { runCli } from "../src/cli.js";

let client: Client;
let stdout: string[];
let stderr: string[];

function deps(
  extra: {
    writeNewFile?: (p: string, c: string) => Promise<void>;
    now?: Date;
  } = {},
) {
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

  it("exposes no write, delete, or migrate command directly on owners/migrate", async () => {
    expect(await runCli(["owners", "delete", "--owner", "alice"], deps())).toBe(2);
    expect(await runCli(["migrate"], deps())).toBe(2);
    expect(stderr.join("\n")).toContain("usage: do-sift-cli");
  });

  describe("retention prune", () => {
    const fixedNow = new Date("2026-11-01T12:00:00.000Z");

    beforeEach(async () => {
      // Old jobs
      await client.execute({
        sql: "INSERT INTO jobs (id, owner_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES ('j1', 'alice', 'k', '{}', 'done', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
      });
      await client.execute({
        sql: "INSERT INTO jobs (id, owner_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES ('j2', 'alice', 'k', '{}', 'queued', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
      });
      await client.execute({
        sql: "INSERT INTO jobs (id, owner_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES ('j3', 'bob', 'k', '{}', 'done', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
      });
    });

    it("requires --owner flag", async () => {
      expect(await runCli(["retention", "prune", "--retention-days", "7"], deps())).toBe(2);
      expect(stderr.join("\n")).toContain("--owner is required");
    });

    it("requires either --retention-days or --cutoff and rejects mutually exclusive flags", async () => {
      expect(await runCli(["retention", "prune", "--owner", "alice"], deps())).toBe(2);
      expect(stderr.join("\n")).toContain("either --retention-days or --cutoff is required");

      expect(
        await runCli(
          [
            "retention",
            "prune",
            "--owner",
            "alice",
            "--retention-days",
            "7",
            "--cutoff",
            "2026-10-01",
          ],
          deps(),
        ),
      ).toBe(2);
      expect(stderr.join("\n")).toContain("cannot specify both --retention-days and --cutoff");
    });

    it("defaults to dry-run mode when --confirm is omitted", async () => {
      expect(
        await runCli(
          ["retention", "prune", "--owner", "alice", "--retention-days", "7"],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("mode\tdry-run");
      expect(text).toContain("candidate_terminal_jobs\t1");
      expect(text).toContain("candidate_closed_usage\t2");
      expect(text).toContain("deleted_terminal_jobs\t0");
      expect(text).toContain("deleted_closed_usage\t0");
      expect(text).toContain("notice: dry-run mode completed. To execute deletion, pass --confirm");

      // Verify no rows actually deleted
      const jobsCount = await client.execute("SELECT COUNT(*) AS c FROM jobs");
      expect(Number(jobsCount.rows[0]?.c)).toBe(3);
    });

    it("deletes rows only when --confirm is explicitly provided", async () => {
      expect(
        await runCli(
          ["retention", "prune", "--owner", "alice", "--retention-days", "7", "--confirm"],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("mode\tprune");
      expect(text).toContain("candidate_terminal_jobs\t1");
      expect(text).toContain("candidate_closed_usage\t2");
      expect(text).toContain("deleted_terminal_jobs\t1");
      expect(text).toContain("deleted_closed_usage\t2");
      expect(text).not.toContain("notice: dry-run mode completed");

      // Verify alice's done job was deleted, but alice's queued job and bob's job remain
      const jobsRes = await client.execute("SELECT id FROM jobs ORDER BY id");
      expect(jobsRes.rows.map((r) => r.id)).toEqual(["j2", "j3"]);

      // Verify alice's usage entries were pruned, but bob's remains
      const usageRes = await client.execute("SELECT id FROM usage_ledger ORDER BY id");
      expect(usageRes.rows.map((r) => r.id)).toEqual(["u3"]);

      // Verify documents & passages untouched
      const docsRes = await client.execute("SELECT id FROM documents ORDER BY id");
      expect(docsRes.rows.map((r) => r.id)).toEqual(["d1", "d2"]);
    });

    it("exports retention audit receipt to JSON using --out", async () => {
      const dir = await mkdtemp(join(tmpdir(), "do-sift-retention-"));
      const outPath = join(dir, "retention-receipt.json");

      expect(
        await runCli(
          ["retention", "prune", "--owner", "alice", "--retention-days", "7", "--out", outPath],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);

      const parsed = JSON.parse(await readFile(outPath, "utf8")) as {
        ownerId: string;
        cutoff: string;
        dryRun: boolean;
        candidates: { terminalJobs: number; closedUsage: number; archivedCollections: number };
        deleted: { terminalJobs: number; closedUsage: number; archivedCollections: number };
        success: boolean;
      };

      expect(parsed.ownerId).toBe("alice");
      expect(parsed.dryRun).toBe(true);
      expect(parsed.candidates.terminalJobs).toBe(1);
      expect(parsed.candidates.closedUsage).toBe(2);
      expect(parsed.candidates.archivedCollections).toBe(0);
      expect(parsed.deleted.terminalJobs).toBe(0);
      expect(parsed.deleted.closedUsage).toBe(0);
      expect(parsed.success).toBe(true);
    });

    it("prunes archived collections only with --prune-collections", async () => {
      await client.execute({
        sql: "INSERT INTO collections (id, tenant_id, owner_id, title, description, created_at, updated_at, archived_at) VALUES ('c1', 'default', 'alice', 'Old', '', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
      });
      await client.execute({
        sql: "INSERT INTO collection_notes (id, collection_id, tenant_id, owner_id, author_id, body, created_at, updated_at) VALUES ('n1', 'c1', 'default', 'alice', 'alice', 'note', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
      });

      expect(
        await runCli(
          ["retention", "prune", "--owner", "alice", "--retention-days", "7", "--confirm"],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      expect(stdout.join("\n")).toContain("deleted_archived_collections\t0");
      expect(
        Number((await client.execute("SELECT COUNT(*) AS c FROM collections")).rows[0]?.c),
      ).toBe(1);

      expect(
        await runCli(
          [
            "retention",
            "prune",
            "--owner",
            "alice",
            "--retention-days",
            "7",
            "--confirm",
            "--prune-collections",
          ],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      expect(stdout.join("\n")).toContain("deleted_archived_collections\t1");
      expect(
        Number((await client.execute("SELECT COUNT(*) AS c FROM collections")).rows[0]?.c),
      ).toBe(0);
      expect(
        Number((await client.execute("SELECT COUNT(*) AS c FROM collection_notes")).rows[0]?.c),
      ).toBe(0);
    });

    it("rejects cutoff crossing into current UTC day", async () => {
      expect(
        await runCli(
          ["retention", "prune", "--owner", "alice", "--cutoff", "2026-11-01T01:00:00Z"],
          deps({ now: fixedNow }),
        ),
      ).toBe(1);
      expect(stderr.join("\n")).toContain("cannot cross into current UTC day");
    });
  });

  describe("retention prune-changes", () => {
    const fixedNow = new Date("2026-11-01T12:00:00.000Z");

    beforeEach(async () => {
      for (const [id, name] of [
        ["acme", "Acme"],
        ["globex", "Globex"],
      ] as const) {
        await client.execute({
          sql: "INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')",
          args: [id, name],
        });
      }
      const changes = [
        ["acme", "old", "2026-09-01T00:00:00Z"],
        ["acme", "new", "2026-10-31T00:00:00Z"],
        ["globex", "old-other", "2026-09-01T00:00:00Z"],
      ] as const;
      for (const [tenant, target, at] of changes) {
        await client.execute({
          sql: "INSERT INTO tenant_member_changes (tenant_id, actor_user_id, target_user_id, action, from_role, to_role, created_at) VALUES (?, 'owner-1', ?, 'added', NULL, 'member', ?)",
          args: [tenant, target, at],
        });
      }
    });

    async function remaining(): Promise<string[]> {
      const res = await client.execute(
        "SELECT target_user_id FROM tenant_member_changes ORDER BY id",
      );
      return res.rows.map((row) => String(row.target_user_id));
    }

    it("requires --tenant and a retention window", async () => {
      expect(await runCli(["retention", "prune-changes", "--retention-days", "30"], deps())).toBe(
        2,
      );
      expect(stderr.join("\n")).toContain("--tenant is required");

      expect(await runCli(["retention", "prune-changes", "--tenant", "acme"], deps())).toBe(2);
      expect(stderr.join("\n")).toContain("either --retention-days or --cutoff is required");
    });

    it("defaults to a dry run and reports candidate counts", async () => {
      expect(
        await runCli(
          ["retention", "prune-changes", "--tenant", "acme", "--retention-days", "30"],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("tenant_id\tacme");
      expect(text).toContain("mode\tdry-run");
      expect(text).toContain("candidate_changes\t1");
      expect(text).toContain("deleted_changes\t0");
      expect(text).toContain("notice: dry-run mode completed. To execute deletion, pass --confirm");
      expect(await remaining()).toEqual(["old", "new", "old-other"]);
    });

    it("deletes only that tenant's old changes when confirmed", async () => {
      expect(
        await runCli(
          ["retention", "prune-changes", "--tenant", "acme", "--retention-days", "30", "--confirm"],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("mode\tprune");
      expect(text).toContain("deleted_changes\t1");
      expect(text).not.toContain("notice: dry-run mode completed");
      expect(await remaining()).toEqual(["new", "old-other"]);
    });

    it("refuses to shorten the review window below the floor", async () => {
      expect(
        await runCli(
          ["retention", "prune-changes", "--tenant", "acme", "--retention-days", "7"],
          deps({ now: fixedNow }),
        ),
      ).toBe(2);
      expect(stderr.join("\n")).toContain("at least 30");

      expect(
        await runCli(
          ["retention", "prune-changes", "--tenant", "acme", "--cutoff", "2026-10-31"],
          deps({ now: fixedNow }),
        ),
      ).toBe(1);
      expect(stderr.join("\n")).toContain("30-day floor");
      expect(await remaining()).toEqual(["old", "new", "old-other"]);
    });

    it("exports the prune receipt with --out", async () => {
      const dir = await mkdtemp(join(tmpdir(), "do-sift-changes-"));
      const outPath = join(dir, "receipt.json");
      expect(
        await runCli(
          [
            "retention",
            "prune-changes",
            "--tenant",
            "acme",
            "--retention-days",
            "30",
            "--out",
            outPath,
          ],
          deps({ now: fixedNow }),
        ),
      ).toBe(0);
      const parsed = JSON.parse(await readFile(outPath, "utf8")) as {
        tenantId: string;
        dryRun: boolean;
        candidates: number;
        deleted: number;
        success: boolean;
      };
      expect(parsed).toMatchObject({ tenantId: "acme", dryRun: true, candidates: 1, deleted: 0 });
      expect(parsed.success).toBe(true);
    });
  });

  describe("report answer", () => {
    async function seedAnswer(): Promise<string> {
      const repos = new Repositories(client);
      const requestId = await repos.requests.create("alice", "answer", "Private report question?");
      return repos.answers.insert({
        ownerId: "alice",
        requestId,
        blocks: [
          { kind: "paragraph", text: "Stored claim about Alpha.", citations: ["p1"] },
          { kind: "caveat", text: "Unresolved claim.", citations: [], unresolved: true },
        ],
        evidenceOnly: false,
      });
    }

    it("renders stored claims and their cited evidence without the question", async () => {
      const answerId = await seedAnswer();
      expect(
        await runCli(["report", "answer", "--owner", "alice", "--answer", answerId], deps()),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("Stored claim about Alpha");
      expect(text).toContain("[p1]");
      expect(text).toContain("https://a.test/x");
      expect(text).toContain("Unresolved claim");
      expect(text).toContain("unresolved citation");
      expect(text).not.toContain("Private report question?");
    });

    it("renders HTML and BibTeX through the same formatter as the HTTP route", async () => {
      const answerId = await seedAnswer();
      expect(
        await runCli(
          ["report", "answer", "--owner", "alice", "--answer", answerId, "--format", "html"],
          deps(),
        ),
      ).toBe(0);
      expect(stdout.join("\n")).toContain("<h1>Research report</h1>");
      expect(stdout.join("\n")).toContain("Stored claim about Alpha");

      stdout = [];
      expect(
        await runCli(
          ["report", "answer", "--owner", "alice", "--answer", answerId, "--format", "bibtex"],
          deps(),
        ),
      ).toBe(0);
      const bib = stdout.join("\n");
      expect(bib).toContain("@misc{");
      expect(bib).toContain("title = {Alpha}");
      expect(bib).toContain("https://a.test/x");
    });

    it("includes the question only on request and writes any format to a new file", async () => {
      const answerId = await seedAnswer();
      expect(
        await runCli(
          ["report", "answer", "--owner", "alice", "--answer", answerId, "--include-question"],
          deps(),
        ),
      ).toBe(0);
      expect(stdout.join("\n")).toContain("Private report question?");

      const dir = await mkdtemp(join(tmpdir(), "do-sift-answer-report-"));
      const out = join(dir, "report.json");
      expect(
        await runCli(
          [
            "report",
            "answer",
            "--owner",
            "alice",
            "--answer",
            answerId,
            "--format",
            "json",
            "--out",
            out,
            "--checksum",
            "--manifest",
          ],
          deps(),
        ),
      ).toBe(0);
      const content = await readFile(out, "utf8");
      const digest = createHash("sha256").update(content, "utf8").digest("hex");
      expect(stdout.join("\n")).toContain(`sha256 ${digest}`);
      expect(await readFile(`${out}.sha256`, "utf8")).toBe(`${digest}  report.json\n`);
      expect(JSON.parse(await readFile(`${out}.manifest.json`, "utf8"))).toEqual({
        manifestVersion: 1,
        reportSchemaVersion: 1,
        format: "json",
        sha256: digest,
        bytes: Buffer.byteLength(content, "utf8"),
        sourceCount: 1,
        claimCount: 2,
        annotationCount: 0,
        questionIncluded: false,
      });
      const quoted = join(dir, "quoted.json");
      expect(
        await runCli(
          [
            "report",
            "answer",
            "--owner",
            "alice",
            "--answer",
            answerId,
            "--format",
            "json",
            "--include-question",
            "--out",
            quoted,
            "--manifest",
          ],
          deps(),
        ),
      ).toBe(0);
      expect(
        (
          JSON.parse(await readFile(`${quoted}.manifest.json`, "utf8")) as {
            questionIncluded: boolean;
          }
        ).questionIncluded,
      ).toBe(true);
      const parsed = JSON.parse(content) as {
        question?: string;
        claims: Array<{ text: string; citations: string[] }>;
        sources: Array<{ url: string }>;
      };
      expect(parsed.question).toBeUndefined();
      expect(parsed.claims[0]).toMatchObject({
        text: "Stored claim about Alpha.",
        citations: ["p1"],
      });
      expect(parsed.sources[0]?.url).toBe("https://a.test/x");

      expect(
        await runCli(
          [
            "report",
            "answer",
            "--owner",
            "alice",
            "--answer",
            answerId,
            "--format",
            "json",
            "--out",
            out,
          ],
          deps(),
        ),
      ).toBe(1);
    });

    it("requires --out when --checksum is requested", async () => {
      const answerId = await seedAnswer();
      expect(
        await runCli(
          ["report", "answer", "--owner", "alice", "--answer", answerId, "--checksum"],
          deps(),
        ),
      ).toBe(2);
      expect(stderr.join("\n")).toContain("--checksum requires --out");

      stderr = [];
      expect(
        await runCli(
          ["report", "answer", "--owner", "alice", "--answer", answerId, "--manifest"],
          deps(),
        ),
      ).toBe(2);
      expect(stderr.join("\n")).toContain("--manifest requires --out");
    });

    it("verifies a report against its generated sidecar or an explicit sidecar", async () => {
      const answerId = await seedAnswer();
      const dir = await mkdtemp(join(tmpdir(), "do-sift-verify-report-"));
      const out = join(dir, "verify.json");
      expect(
        await runCli(
          [
            "report",
            "answer",
            "--owner",
            "alice",
            "--answer",
            answerId,
            "--format",
            "json",
            "--out",
            out,
            "--checksum",
          ],
          deps(),
        ),
      ).toBe(0);
      const digest = createHash("sha256")
        .update(await readFile(out, "utf8"), "utf8")
        .digest("hex");

      stdout = [];
      expect(await runCli(["report", "verify", "--in", out], deps())).toBe(0);
      expect(stdout.join("\n")).toBe(`verified ${out} sha256 ${digest}`);

      const custom = join(dir, "custom.sha256");
      await writeFile(custom, `${digest}  verify.json\n`);
      stdout = [];
      expect(await runCli(["report", "verify", "--in", out, "--sidecar", custom], deps())).toBe(0);
      expect(stdout.join("\n")).toBe(`verified ${out} sha256 ${digest}`);
    });

    it("validates the manifest sidecar", async () => {
      const answerId = await seedAnswer();
      const dir = await mkdtemp(join(tmpdir(), "do-sift-verify-manifest-"));
      const out = join(dir, "manifest.json");
      expect(
        await runCli(
          [
            "report",
            "answer",
            "--owner",
            "alice",
            "--answer",
            answerId,
            "--format",
            "json",
            "--out",
            out,
            "--checksum",
            "--manifest",
          ],
          deps(),
        ),
      ).toBe(0);
      const manifestPath = `${out}.manifest.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        sha256: string;
        bytes: number;
      };

      stdout = [];
      expect(await runCli(["report", "verify", "--in", out, "--manifest"], deps())).toBe(0);
      expect(stdout.join("\n")).toContain(`manifest ${manifestPath}`);

      await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
      stderr = [];
      expect(await runCli(["report", "verify", "--in", out, "--manifest"], deps())).toBe(1);
      expect(stderr.join("\n")).toContain("manifest checksum mismatch");

      await writeFile(manifestPath, JSON.stringify({ ...manifest, bytes: manifest.bytes + 1 }));
      stderr = [];
      expect(await runCli(["report", "verify", "--in", out, "--manifest"], deps())).toBe(1);
      expect(stderr.join("\n")).toContain("manifest byte count mismatch");

      await writeFile(manifestPath, "{}");
      stderr = [];
      expect(await runCli(["report", "verify", "--in", out, "--manifest"], deps())).toBe(1);
      expect(stderr.join("\n")).toContain("manifest does not match");
    });

    it("rejects a mismatched, misnamed, or missing checksum", async () => {
      const answerId = await seedAnswer();
      const dir = await mkdtemp(join(tmpdir(), "do-sift-verify-report-"));
      const out = join(dir, "verify.json");
      expect(
        await runCli(
          [
            "report",
            "answer",
            "--owner",
            "alice",
            "--answer",
            answerId,
            "--format",
            "json",
            "--out",
            out,
            "--checksum",
          ],
          deps(),
        ),
      ).toBe(0);
      const content = await readFile(out, "utf8");
      const digest = createHash("sha256").update(content, "utf8").digest("hex");

      await writeFile(out, `${content}\n`);
      expect(await runCli(["report", "verify", "--in", out], deps())).toBe(1);
      expect(stderr.join("\n")).toContain("checksum mismatch");

      await writeFile(out, content);
      await writeFile(`${out}.sha256`, `${digest}  other.json\n`);
      stderr = [];
      expect(await runCli(["report", "verify", "--in", out], deps())).toBe(1);
      expect(stderr.join("\n")).toContain("checksum names other.json");

      await writeFile(`${out}.sha256`, "not a checksum\n");
      stderr = [];
      expect(await runCli(["report", "verify", "--in", out], deps())).toBe(1);
      expect(stderr.join("\n")).toContain("checksum file must be");

      stderr = [];
      expect(await runCli(["report", "verify"], deps())).toBe(2);
      expect(stderr.join("\n")).toContain("--in is required");
    });

    it("rejects unknown answers, other owners' answers, and unsupported formats", async () => {
      const answerId = await seedAnswer();
      expect(
        await runCli(["report", "answer", "--owner", "bob", "--answer", answerId], deps()),
      ).toBe(1);
      expect(stderr.join("\n")).toContain(`answer ${answerId} not found for owner bob`);

      stderr = [];
      expect(
        await runCli(
          ["report", "answer", "--owner", "alice", "--answer", answerId, "--format", "pdf"],
          deps(),
        ),
      ).toBe(2);
      expect(stderr.join("\n")).toContain("--format must be one of: json, markdown, html, bibtex");
    });
  });

  describe("report collection", () => {
    async function seedCollection(): Promise<void> {
      await client.execute(
        "INSERT INTO collections (id, tenant_id, owner_id, title, description, created_at, updated_at) VALUES ('colrpt','default','alice','Reported collection','', '2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
      );
      await client.execute(
        `INSERT INTO collection_items (collection_id, tenant_id, owner_id, item_kind, item_id, added_at, evidence_url, evidence_title, evidence_fetched_at)
         VALUES ('colrpt','default','alice','evidence','d1','2026-10-02T00:00:00Z','https://a.test/x','Alpha','2026-10-02T10:00:01Z'),
                ('colrpt','default','alice','evidence','missing','2026-10-03T00:00:00Z',NULL,NULL,NULL),
                ('colrpt','default','alice','run','req1','2026-10-04T00:00:00Z',NULL,NULL,NULL)`,
      );
      await client.execute(
        "INSERT INTO collection_notes (id, collection_id, tenant_id, owner_id, author_id, body, created_at, updated_at) VALUES ('n1','colrpt','default','alice','alice','Owner note about Alpha.','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z')",
      );
    }

    it("exports every attachment beyond the 100-item detail cap", async () => {
      await client.execute(
        "INSERT INTO collections (id, tenant_id, owner_id, title, description, created_at, updated_at) VALUES ('colbig','default','alice','Large collection','','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
      );
      for (let i = 0; i < 105; i++) {
        const id = `e${String(i).padStart(3, "0")}`;
        await client.execute({
          sql: `INSERT INTO collection_items
                  (collection_id, tenant_id, owner_id, item_kind, item_id, added_at,
                   evidence_url, evidence_title, evidence_fetched_at)
                VALUES ('colbig','default','alice','evidence',?,?,?,?,?)`,
          args: [
            id,
            `2026-10-02T00:00:${String(i % 60).padStart(2, "0")}Z`,
            `https://big.test/${id}`,
            id,
            "2026-10-02T10:00:00Z",
          ],
        });
      }

      expect(
        await runCli(
          [
            "report",
            "collection",
            "--owner",
            "alice",
            "--collection",
            "colbig",
            "--format",
            "json",
          ],
          deps(),
        ),
      ).toBe(0);
      const parsed = JSON.parse(stdout.join("\n")) as { sources: Array<{ id: string }> };
      expect(parsed.sources).toHaveLength(105);
      expect(parsed.sources.at(-1)?.id).toBe("e104");
    });

    it("renders snapshotted sources and keeps owner notes private by default", async () => {
      await seedCollection();
      expect(
        await runCli(
          ["report", "collection", "--owner", "alice", "--collection", "colrpt"],
          deps(),
        ),
      ).toBe(0);
      const text = stdout.join("\n");
      expect(text).toContain("**Collection:** Reported collection");
      expect(text).toContain("https://a.test/x");
      expect(text).toContain("Alpha");
      expect(text).not.toContain("Owner note about Alpha");

      stdout = [];
      expect(
        await runCli(
          [
            "report",
            "collection",
            "--owner",
            "alice",
            "--collection",
            "colrpt",
            "--include-annotations",
          ],
          deps(),
        ),
      ).toBe(0);
      expect(stdout.join("\n")).toContain("Owner note about Alpha");
      expect(stdout.join("\n")).toContain("Owner annotations");
    });

    it("writes JSON with resolved evidence only and rejects foreign ids", async () => {
      await seedCollection();
      const dir = await mkdtemp(join(tmpdir(), "do-sift-collection-report-"));
      const out = join(dir, "collection.json");
      expect(
        await runCli(
          [
            "report",
            "collection",
            "--owner",
            "alice",
            "--collection",
            "colrpt",
            "--format",
            "json",
            "--include-annotations",
            "--out",
            out,
            "--checksum",
            "--manifest",
          ],
          deps(),
        ),
      ).toBe(0);
      const content = await readFile(out, "utf8");
      const digest = createHash("sha256").update(content, "utf8").digest("hex");
      expect(stdout.join("\n")).toContain(`sha256 ${digest}`);
      expect(await readFile(`${out}.sha256`, "utf8")).toBe(`${digest}  collection.json\n`);
      expect(JSON.parse(await readFile(`${out}.manifest.json`, "utf8"))).toEqual({
        manifestVersion: 1,
        reportSchemaVersion: 1,
        format: "json",
        sha256: digest,
        bytes: Buffer.byteLength(content, "utf8"),
        sourceCount: 1,
        claimCount: 0,
        annotationCount: 1,
        questionIncluded: false,
      });
      const parsed = JSON.parse(content) as {
        collection?: { title: string; description?: string };
        sources: Array<{ id: string; url: string }>;
        annotations: Array<{ body: string }>;
      };
      expect(parsed.collection).toEqual({ title: "Reported collection" });
      expect(parsed.sources).toEqual([
        { id: "d1", url: "https://a.test/x", title: "Alpha", fetchedAt: "2026-10-02T10:00:01Z" },
      ]);
      expect(parsed.annotations[0]?.body).toBe("Owner note about Alpha.");

      expect(
        await runCli(["report", "collection", "--owner", "bob", "--collection", "colrpt"], deps()),
      ).toBe(1);
      expect(stderr.join("\n")).toContain("collection colrpt not found for owner bob");

      stderr = [];
      expect(
        await runCli(
          ["report", "collection", "--owner", "alice", "--collection", "colrpt", "--format", "pdf"],
          deps(),
        ),
      ).toBe(2);
      expect(stderr.join("\n")).toContain("--format must be one of");
    });
  });

  describe("collections backfill", () => {
    it("dry-runs and then snapshots only legacy evidence references", async () => {
      await client.execute(
        "INSERT INTO collections (id, tenant_id, owner_id, title, description, created_at, updated_at) VALUES ('col1','default','alice','Legacy','', '2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
      );
      await client.execute(
        `INSERT INTO collection_items (collection_id, tenant_id, owner_id, item_kind, item_id, added_at)
         VALUES ('col1','default','alice','evidence','d1','2026-10-02T00:00:00Z'),
                ('col1','default','alice','evidence','missing','2026-10-03T00:00:00Z')`,
      );

      expect(
        await runCli(["collections", "backfill", "--owner", "alice", "--dry-run"], deps()),
      ).toBe(0);
      let text = stdout.join("\n");
      expect(text).toContain("mode\tdry-run");
      expect(text).toContain("scanned\t2");
      expect(text).toContain("updated\t1");
      expect(text).toContain("unresolved\t1");
      expect(
        (await client.execute("SELECT evidence_url FROM collection_items WHERE item_id='d1'"))
          .rows[0]?.evidence_url,
      ).toBeNull();

      stdout = [];
      expect(await runCli(["collections", "backfill", "--owner", "alice"], deps())).toBe(0);
      text = stdout.join("\n");
      expect(text).toContain("mode\tbackfill");
      expect(text).toContain("updated\t1");
      expect(
        (await client.execute("SELECT evidence_url FROM collection_items WHERE item_id='d1'"))
          .rows[0]?.evidence_url,
      ).toBe("https://a.test/x");
    });

    it("refuses a collection outside the owner's scope", async () => {
      expect(
        await runCli(["collections", "backfill", "--owner", "bob", "--collection", "col1"], deps()),
      ).toBe(1);
      expect(stderr.join("\n")).toContain("not found for owner bob");
    });
  });

  describe("analytics summarize", () => {
    async function evalFile(rows: unknown): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "do-sift-analytics-"));
      const input = join(dir, "rows.json");
      await writeFile(input, JSON.stringify(rows));
      return input;
    }

    const rows = [
      {
        id: "e1",
        provider: "alpha",
        dataset: "q",
        recall: 0.5,
        latencyMs: 100,
        createdDay: "2026-11-01",
      },
      {
        id: "e2",
        provider: "alpha",
        dataset: "q",
        recall: 1,
        latencyMs: 300,
        createdDay: "2026-11-02",
      },
    ];

    it("prints one aggregate row per provider/dataset with its sample count", async () => {
      const input = await evalFile(rows);
      expect(await runCli(["analytics", "summarize", "--in", input], deps())).toBe(0);
      expect(stdout[0]).toBe(
        "provider\tdataset\tn\tmean_recall\tmin_recall\tmax_recall\tmean_latency",
      );
      expect(stdout[1]).toBe("alpha\tq\t2\t0.75\t0.5\t1\t200");
    });

    it("writes JSON aggregates to a new file and refuses to overwrite", async () => {
      const input = await evalFile(rows);
      const dir = await mkdtemp(join(tmpdir(), "do-sift-analytics-out-"));
      const out = join(dir, "aggregates.json");
      expect(
        await runCli(
          ["analytics", "summarize", "--in", input, "--format", "json", "--out", out],
          deps(),
        ),
      ).toBe(0);
      const parsed = JSON.parse(await readFile(out, "utf8")) as Array<{ n: number }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.n).toBe(2);

      expect(
        await runCli(
          ["analytics", "summarize", "--in", input, "--format", "json", "--out", out],
          deps(),
        ),
      ).toBe(1);
    });

    it("rejects malformed rows, missing input, and an unknown format", async () => {
      const missingProvider = await evalFile([{ ...rows[0], provider: undefined }]);
      expect(await runCli(["analytics", "summarize", "--in", missingProvider], deps())).toBe(1);

      const notAnArray = await evalFile({ rows });
      expect(await runCli(["analytics", "summarize", "--in", notAnArray], deps())).toBe(1);

      expect(await runCli(["analytics", "summarize"], deps())).toBe(2);
      const input = await evalFile(rows);
      expect(
        await runCli(["analytics", "summarize", "--in", input, "--format", "csv"], deps()),
      ).toBe(2);
    });
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
