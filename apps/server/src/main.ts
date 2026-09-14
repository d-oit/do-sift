/**
 * OPS-05 (plan 005-007): the packaged service entrypoint's composition.
 * Wires in one place: local libSQL storage + migrations + owner seed, auth
 * (allowlist + optional loopback dev bypass), the RET-04 runtime (research
 * + answer over hybrid retrieval), and the SRC-05 HTTP server.
 *
 * Provider selection is fail-closed and honest (parseEnvConfig): only
 * labeled fixtures exist today, so fixture mode is the supported offline
 * dev posture and the startup log says so. fetchPage in fixture mode is a
 * synthetic page store — .test hosts never resolve on purpose, and nothing
 * leaves the process. safe-fetch + site-access policy enter with the first
 * live search adapter (SRC-02 gate), not silently before it.
 */
import { createClient, type Client } from "@libsql/client";
import { AuthService, StaticOidcVerifier } from "@do-sift/auth";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import type { PageContent } from "@do-sift/plugin-harness-research";
import {
  createResearchServer,
  createRuntime,
  listen,
  type ResearchRunOutcome,
  type Runtime,
} from "@do-sift/server";
import {
  applyMigrations,
  createFastEmbedEmbedder,
  loadMigrations,
  Repositories,
  type TextEmbedder,
} from "@do-sift/storage";
import { parseEnvConfig, type AppConfig } from "./config.js";

// The policy treats apps/ like plugin territory: no raw node:http import.
// The server type comes from the factory's return type instead.
type HttpServer = ReturnType<typeof createResearchServer>;

/** Synthetic pages for fixture mode: .test hosts are reserved and never resolve. */
const FIXTURE_PAGES: Record<string, { title: string; text: string }> = {
  "https://docs.test/fts5": {
    title: "FTS5 notes",
    text: [
      "FTS5 is SQLite's virtual table module for full-text search.",
      "FTS5 ranks keyword matches with bm25, where lower scores are better.",
      "The bm25 function weighs rarer terms more heavily in the ranking, so distinctive words dominate the score.",
      "Prefix queries and the highlight() helper make FTS5 convenient for ad-hoc search interfaces.",
    ].join("\n\n"),
  },
  "https://guide.test/hybrid": {
    title: "Hybrid retrieval notes",
    text: [
      "Hybrid retrieval fuses lexical and dense rankings with reciprocal rank fusion.",
      "Dense retrieval embeds passages into vectors and compares cosine similarity.",
      "Fusion helps paraphrase queries that share little lexical overlap with the corpus.",
    ].join("\n\n"),
  },
};

const FIXTURE_SEARCH_HITS = [
  { url: "https://docs.test/fts5", title: "FTS5 notes", snippet: "fts5 bm25 ranking", rank: 0 },
  {
    url: "https://guide.test/hybrid",
    title: "Hybrid retrieval notes",
    snippet: "hybrid retrieval fusion",
    rank: 1,
  },
];

export interface ComposeDeps {
  /** Test seam: overrides config.dbUrl (e.g. ":memory:" for hermetic tests). */
  dbUrl?: string;
  /**
   * Test seam: overrides config.port. Windows quirk: re-binding the same
   * fixed port back-to-back after close() can reset connections
   * (SO_REUSEADDR double-bind), so hermetic tests pass 0 (ephemeral).
   */
  port?: number;
}

export interface ComposedApp {
  config: AppConfig;
  server: HttpServer;
  runtime: Runtime;
  repositories: Repositories;
  client: Client;
  /** Bound port (the listen() result). */
  port: number;
  close(): Promise<void>;
}

export async function composeApp(config: AppConfig, deps: ComposeDeps = {}): Promise<ComposedApp> {
  const client = createClient({ url: deps.dbUrl ?? config.dbUrl });
  const repositories = new Repositories(client);
  await applyMigrations(client, loadMigrations(config.migrationsDir));
  for (const owner of config.owners) {
    await repositories.owners.ensure(owner, owner);
  }

  const search = new FakeSearchProvider({ hits: FIXTURE_SEARCH_HITS });
  const fetchPage = async (fetchUrl: string): Promise<PageContent> => {
    const page = FIXTURE_PAGES[fetchUrl];
    if (page === undefined) {
      throw new Error(`fixture page store has no page for ${fetchUrl}`);
    }
    return { text: page.text, contentType: "text/html" };
  };

  let embedder: TextEmbedder | undefined;
  if (config.embedder === "fastembed") {
    embedder = await createFastEmbedEmbedder();
  }

  const model = config.modelProvider === "fixture" ? new FakeModelProvider() : undefined;

  const runtime = await createRuntime({
    client,
    search,
    fetchPage,
    ...(model === undefined ? {} : { model }),
    ...(embedder === undefined ? {} : { embedder }),
  });

  const auth = new AuthService(
    // Empty token map: bearer tokens refuse until a real OIDC verifier
    // lands (sources.md gate); the loopback dev bypass is the dev path.
    new StaticOidcVerifier({}),
    {
      allowlist: config.owners,
      devBypass: config.devBypass,
      ...(config.devOwner === undefined ? {} : { devOwner: config.devOwner }),
    },
  );

  const server = createResearchServer({
    auth,
    runResearch: (ownerId, question, onSource): Promise<ResearchRunOutcome> =>
      runtime.runResearch(ownerId, question, onSource),
    ...(model === undefined
      ? {}
      : {
          answer: (ownerId: string, question: string) => runtime.answerResponse(ownerId, question),
        }),
  });

  const port = await listen(server, config.host, deps.port ?? config.port);

  return {
    config,
    server,
    runtime,
    repositories,
    client,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.close();
    },
  };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = parseEnvConfig(env);
  const app = await composeApp(config);

  console.log(`do-sift listening on http://${config.host}:${app.port}`);
  console.log(
    `  db: ${config.dbUrl} (migrations: ${config.migrationsDir}); owners: ${config.owners.length} allowlisted; dev bypass: ${config.devBypass ? "ON (loopback-only)" : "off"}`,
  );
  console.log(
    `  search: fixture (synthetic, dev only) | model: ${config.modelProvider === undefined ? "not configured (/api/answer → 501)" : "fixture (synthetic, dev only)"} | embedder: ${config.embedder ?? "keyword-only"}`,
  );

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
