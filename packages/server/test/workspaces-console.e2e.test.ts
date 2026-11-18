/**
 * FUP-03: the real workspaces console in a real browser, against a real
 * server. Covers load evidence → compare → create collection → open → add
 * note → download a report. The Linux CI check installs Chromium; other
 * machines can opt out explicitly with DO_SIFT_ALLOW_BROWSER_SKIP=1.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { chromium, type Browser, type Download, type Page } from "playwright";
import { AuthError } from "@do-sift/auth";
import { buildAnswerReport, buildCollectionReport, type TenantRole } from "@do-sift/contracts";
import {
  CollectionsRepository,
  Repositories,
  applyMigrations,
  loadMigrations,
} from "@do-sift/storage";
import {
  createResearchServer,
  listen,
  type CollectionsHandlers,
  type CompareHandlers,
  type ResearchServerOptions,
} from "../src/index.js";

let client: Client;
let server: Server;

// Chromium launch competes with the rest of the suite; give this real-browser
// hook more room than Vitest's 30s default while keeping it bounded.
const BROWSER_HOOK_TIMEOUT_MS = 60_000;
let port: number;
let browser: Browser | undefined;
let browserAnswerId: string;

const auth: ResearchServerOptions["auth"] = {
  authenticateOwner: async ({ token }) => {
    if (token !== "browser-token") throw new AuthError("invalid-token", "no usable token");
    return { ownerId: "browser-member", via: "oidc", tenantId: "acme" };
  },
};

const emptyRun: ResearchServerOptions["runResearch"] = async () => ({
  hits: 0,
  documentsStored: 0,
  passagesStored: 0,
  denied: 0,
  fetchErrors: 0,
  skippedBudget: 0,
});

function roleFor(): Promise<TenantRole> {
  return Promise.resolve("member");
}

function collectionsFor(principal: {
  tenantId: string;
  userId: string;
}): Promise<CollectionsHandlers> {
  const repo = new CollectionsRepository(client, principal.userId, principal.tenantId);
  return Promise.resolve({
    list: (_ownerId, options) => repo.list(options),
    create: (_ownerId, input) => repo.create(input.title, input.description),
    get: async (_ownerId, id) => {
      const collection = await repo.get(id);
      if (collection === undefined) return undefined;
      const [items, notes, totalItems] = await Promise.all([
        repo.items(id),
        repo.notes(id),
        repo.countItems(id),
      ]);
      return {
        collection,
        items: items.map((item) => ({
          kind: item.itemKind,
          id: item.itemId,
          addedAt: item.addedAt,
        })),
        totalItems,
        notes,
      };
    },
    update: (_ownerId, id, changes) => {
      const next: { title?: string; description?: string } = {};
      if (changes.title !== undefined) next.title = changes.title;
      if (changes.description !== undefined) next.description = changes.description;
      return repo.update(id, next);
    },
    archive: (_ownerId, id) => repo.archive(id),
    addItem: (_ownerId, id, kind, itemId) => repo.addItem(id, kind, itemId),
    removeItem: (_ownerId, id, kind, itemId) => repo.removeItem(id, kind, itemId),
    addNote: (_ownerId, id, body) => repo.addNote(id, body),
    notes: (_ownerId, id) => repo.notes(id),
    deleteNote: (_ownerId, id, noteId) => repo.deleteNote(noteId),
  });
}

function compareFor(principal: { tenantId: string }): Promise<CompareHandlers> {
  const repos = new Repositories(client, principal.tenantId);
  return Promise.resolve({
    sources: (ownerId, ids) => repos.passages.compareSources(ownerId, ids),
  });
}

async function seedEvidence(): Promise<void> {
  for (const [suffix, title] of [
    ["a", "Browser source A"],
    ["b", "Browser source B"],
  ] as const) {
    await client.execute({
      sql: `INSERT INTO documents (id, tenant_id, owner_id, canonical_url, original_url, content_hash, fetched_at, title, created_at)
            VALUES (?, 'acme', 'browser-member', ?, ?, ?, '2026-11-01T00:00:00Z', ?, '2026-11-01T00:00:00Z')`,
      args: [
        `doc-browser-${suffix}`,
        `https://browser-${suffix}.test/page`,
        `https://browser-${suffix}.test/page`,
        `hash-browser-${suffix}`,
        title,
      ],
    });
    await client.execute({
      sql: `INSERT INTO passages (id, tenant_id, owner_id, document_id, heading, excerpt, extraction_status, created_at)
            VALUES (?, 'acme', 'browser-member', ?, 'Heading', ?, 'ok', '2026-11-01T00:00:01Z')`,
      args: [
        `psg-browser-${suffix}`,
        `doc-browser-${suffix}`,
        `Excerpt from browser source ${suffix}.`,
      ],
    });
  }
}

async function waitForText(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ timeout: 10_000 });
}

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO tenants (id, display_name, created_at) VALUES ('acme', 'Acme', '2026-01-01T00:00:00Z')",
  });
  await client.execute({
    sql: "INSERT INTO owners (id, tenant_id, display_name, created_at) VALUES ('browser-member', 'acme', 'Browser', '2026-01-01T00:00:00Z')",
  });
  await seedEvidence();
  const seedRepos = new Repositories(client, "acme");
  const requestId = await seedRepos.requests.create(
    "browser-member",
    "answer",
    "What did the browser retrieve?",
  );
  browserAnswerId = await seedRepos.answers.insert({
    ownerId: "browser-member",
    requestId,
    blocks: [
      {
        kind: "paragraph",
        text: "Browser claim about alpha.",
        citations: ["psg-browser-a"],
      },
    ],
    evidenceOnly: false,
  });

  server = createResearchServer({
    auth,
    runResearch: emptyRun,
    roleFor,
    collectionsFor,
    compareFor,
    // The console loads the same evidence list the production read surface
    // serves, so the browser test exercises the real ids it compares.
    reportFor: (principal: { tenantId: string; userId: string }) => {
      const collections = new CollectionsRepository(client, principal.userId, principal.tenantId);
      const repos = new Repositories(client, principal.tenantId);
      return Promise.resolve({
        fromAnswer: async (ownerId: string, answerId: string) => {
          const input = await repos.answers.reportInput(ownerId, answerId);
          if (input === undefined) return undefined;
          return buildAnswerReport({
            question: input.question,
            createdAt: input.createdAt,
            blocks: input.blocks.map((block) => ({
              kind: block.kind,
              text: block.text,
              citations: block.citations,
              ...(block.unresolved === true ? { unresolved: true } : {}),
            })),
            sources: input.sources.map((source) => ({
              id: source.evidenceId,
              url: source.url,
              ...(source.title === undefined ? {} : { title: source.title }),
              fetchedAt: source.retrievedAt,
            })),
          });
        },
        fromCollection: async (_ownerId: string, collectionId: string) => {
          const collection = await collections.get(collectionId);
          if (collection === undefined) return undefined;
          const [items, notes] = await Promise.all([
            collections.allItems(collectionId),
            collections.notes(collectionId),
          ]);
          return buildCollectionReport({
            title: collection.title,
            description: collection.description,
            createdAt: collection.createdAt,
            sources: items.flatMap((item) =>
              item.evidenceUrl === undefined || item.evidenceFetchedAt === undefined
                ? []
                : [
                    {
                      id: item.itemId,
                      url: item.evidenceUrl,
                      ...(item.evidenceTitle === undefined ? {} : { title: item.evidenceTitle }),
                      fetchedAt: item.evidenceFetchedAt,
                    },
                  ],
            ),
            annotations: notes.map((note) => ({
              id: note.id,
              body: note.body,
              createdAt: note.createdAt,
            })),
          });
        },
      });
    },
    readFor: (principal: { tenantId: string }) => {
      const repos = new Repositories(client, principal.tenantId);
      return Promise.resolve({
        evidence: async (ownerId: string, limit: number) =>
          (await repos.documents.listPage(ownerId, limit)).map((row) => ({
            id: row.id,
            url: row.canonicalUrl,
            ...(row.title === undefined ? {} : { title: row.title }),
            fetchedAt: row.fetchedAt,
          })),
        answers: (ownerId: string, limit: number) => repos.answers.list(ownerId, limit),
      });
    },
  });
  port = await listen(server);

  try {
    browser = await chromium.launch();
  } catch (error) {
    if ((process.env.DO_SIFT_ALLOW_BROWSER_SKIP ?? "").trim() === "1") return;
    throw error;
  }
}, BROWSER_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  // Browser keep-alive sockets keep server.close() waiting; drop them before
  // waiting for the listener so teardown stays bounded under a loaded pool.
  const closable = server as unknown as { closeAllConnections?: () => void };
  closable.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  client?.close();
}, BROWSER_HOOK_TIMEOUT_MS);

describe("workspaces console (real browser)", () => {
  it("compares evidence, keeps a collection note, and downloads a report", async () => {
    if (browser === undefined) return;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(`http://127.0.0.1:${port}/workspaces`);
    await page.locator("#token").fill("browser-token");
    await page.getByRole("button", { name: "Use token" }).click();
    await waitForText(page, "#auth-status", "Token stored");

    await page.getByRole("button", { name: "Load evidence" }).click();
    await waitForText(page, "#evidence-status", "2 evidence row(s)");
    const boxes = page.locator("#evidence-list input[type=checkbox]");
    await boxes.nth(0).check();
    await boxes.nth(1).check();

    await page.getByRole("button", { name: "Compare selected" }).click();
    await waitForText(page, "#compare-status", "Schema v1");
    await waitForText(page, "#compare-result", "Browser source A");

    await page.locator("#collection-title").fill("Browser smoke");
    await page.getByRole("button", { name: "Create" }).click();
    await waitForText(page, "#collection-status", "1 collection(s)");
    await page.getByRole("button", { name: "Open" }).click();
    await waitForText(page, "#collection-detail", "0 item(s)");

    await page
      .locator("#collection-detail input[placeholder='Existing evidence id']")
      .fill("doc-browser-a");
    await page.getByRole("button", { name: "Attach evidence" }).click();
    await waitForText(page, "#collection-detail", "doc-browser-a");
    await waitForText(page, "#collection-detail", "1 item(s)");

    await page
      .locator("#collection-detail input[placeholder^='Owner note']")
      .fill("note from browser");
    await page.getByRole("button", { name: "Add note" }).click();
    await waitForText(page, "#collection-detail", "note from browser");

    // The collection report is built server-side from stored item metadata,
    // without the console sending its evidence list.
    const collectionDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download collection report" }).click();
    const collectionDownload = await collectionDownloadPromise;
    expect(collectionDownload.suggestedFilename()).toBe("report.md");
    const collectionMarkdown = await downloadText(collectionDownload);
    expect(collectionMarkdown).toContain("**Collection:** Browser smoke");
    expect(collectionMarkdown).toContain("https://browser-a.test/page");
    expect(collectionMarkdown).toContain("note from browser");

    await page.locator("#stored-answer-id").fill(browserAnswerId);
    const answerDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download stored answer report" }).click();
    const answerDownload = await answerDownloadPromise;
    expect(answerDownload.suggestedFilename()).toBe("report.md");
    const answerMarkdown = await downloadText(answerDownload);
    expect(answerMarkdown).toContain("Browser claim about alpha");
    expect(answerMarkdown).toContain("psg-browser-a");
    expect(answerMarkdown).toContain("https://browser-a.test/page");
    expect(answerMarkdown).not.toContain("What did the browser retrieve?");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download report" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("report.md");
    const markdown = await downloadText(download);
    expect(markdown).toContain("https://browser-a.test/page");
    expect(markdown).toContain("https://browser-b.test/page");

    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);
});
