/**
 * do-sift MCP server over stdio (issue #122, plan 037).
 *
 * `npx tsx apps/mcp/src/index.ts` speaks newline-delimited JSON-RPC 2.0 on
 * stdin/stdout, which is what a Python (or any other) MCP client launches as a
 * subprocess. The host capabilities are composed from the same runtime the
 * HTTP server uses; the protocol itself lives in
 * `packages/server/src/mcp.ts` and is transport-free.
 *
 * stdout is reserved for protocol messages — all diagnostics go to stderr, as
 * the MCP stdio transport requires.
 */
import { createClient } from "@libsql/client";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import { createRuntime, handleLine, createSession, type McpHost } from "@do-sift/server";
import { applyMigrations, loadMigrations, Repositories } from "@do-sift/storage";

const OWNER_ID = process.env["DO_SIFT_MCP_OWNER"] ?? "mcp-owner";
const TENANT_ID = process.env["DO_SIFT_MCP_TENANT"] ?? "default";
const DB_URL = process.env["DO_SIFT_DB_URL"] ?? ":memory:";

function log(line: string): void {
  process.stderr.write(`do-sift-mcp: ${line}\n`);
}

/**
 * A local, zero-network host: fixture providers over an in-memory database.
 * Live providers need the composition in `apps/server`, which owns the terms
 * gates and the safe-fetch pipeline; this entrypoint exists so a non-Node
 * client can exercise the protocol without a deployment.
 */
export async function composeMcpHost(): Promise<McpHost> {
  const client = createClient({ url: DB_URL });
  await applyMigrations(client, loadMigrations("migrations"));
  const repositories = new Repositories(client, TENANT_ID);
  await repositories.owners.ensure(OWNER_ID, OWNER_ID);

  const runtime = await createRuntime({
    client,
    search: new FakeSearchProvider({
      hits: [{ url: "https://fixture.test/page", title: "Fixture page" }],
    }),
    fetchPage: async (url) => ({
      text: `<html><body><p>Fixture page for ${url}.</p></body></html>`,
      contentType: "text/html",
    }),
    model: new FakeModelProvider(),
    tenantId: TENANT_ID,
  });

  return {
    search: async ({ question, limit }) => {
      const summary = await runtime.runResearch(OWNER_ID, question);
      return {
        question,
        requestId: summary.requestId,
        hits: summary.hits,
        documentsStored: summary.documentsStored,
        passagesStored: summary.passagesStored,
        ...(limit === undefined ? {} : { requestedLimit: limit }),
      };
    },
    answer: async ({ question }) => {
      const outcome = await runtime.answerResponse(OWNER_ID, question);
      return {
        question,
        answerId: outcome.answerId,
        blocks: outcome.blocks,
        evidenceOnly: outcome.evidenceOnly,
        degraded: outcome.degraded,
        ...(outcome.degradationReason === undefined
          ? {}
          : { degradationReason: outcome.degradationReason }),
      };
    },
    evidence: async ({ limit }) => {
      const rows = await repositories.documents.list(OWNER_ID, limit ?? 20);
      return rows.map((row) => ({
        id: row.id,
        url: row.canonicalUrl,
        title: row.title ?? null,
        fetchedAt: row.fetchedAt,
      }));
    },
  };
}

async function main(): Promise<void> {
  const host = await composeMcpHost();
  const options = { host, log };
  const session = createSession();

  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const response = await handleLine(options, session, line);
      if (response !== undefined) process.stdout.write(`${response}\n`);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "") {
    const response = await handleLine(options, session, buffer);
    if (response !== undefined) process.stdout.write(`${response}\n`);
  }
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
