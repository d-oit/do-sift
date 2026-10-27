/** Shared real-server fixture for the HTTP surface tests (OPS-05, OPS-09): one listening server per importing file. */
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { AuthService, StaticOidcVerifier, type VerifiedIdentity } from "@do-sift/auth";
import { FakeSearchProvider } from "@do-sift/fake-providers";
import {
  createResearchHarness,
  type ResearchHarnessInstance,
} from "@do-sift/plugin-harness-research";
import { createReadabilityExtractor } from "@do-sift/plugin-extract-readability";
import { BudgetService, Repositories, applyMigrations, loadMigrations } from "@do-sift/storage";
import { createResearchServer, listen, type SourceCard } from "../src/index.js";
export const PAGE_A = [
  "Alpha is the first paragraph of page A and carries the primary claim about the topic at hand.",
  "Beta is the second paragraph of page A with supporting detail and a secondary observation.",
].join("\n\n");
export let client: Client;
export let server: Server;
export let port: number;
export let ownerSeen: string | undefined;

/** Imported bindings are read-only for importers; reset through the module. */
export function resetOwnerSeen(): void {
  ownerSeen = undefined;
}
export const ALICE: VerifiedIdentity = {
  subject: "owner-alice",
  issuer: "https://stub-issuer.test",
  claims: {},
};
export async function runResearch(
  ownerId: string,
  question: string,
  onSource: (source: SourceCard) => void,
): Promise<{
  hits: number;
  documentsStored: number;
  passagesStored: number;
  denied: number;
  fetchErrors: number;
  skippedBudget: number;
}> {
  ownerSeen = ownerId;
  const repos = new Repositories(client);
  const search = new FakeSearchProvider({
    hits: [{ url: "https://a.test/page", title: "Page A", snippet: "alpha", rank: 0 }],
  });
  const harness: ResearchHarnessInstance = createResearchHarness(
    { events: { emit: () => {} }, config: {} } as unknown as Parameters<
      typeof createResearchHarness
    >[0],
    {
      search,
      fetchPage: async () => ({ text: PAGE_A, contentType: "text/html" }),
      repositories: repos,
      budget: new BudgetService(client, {
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        maxSearchCalls: 10,
        maxFetches: 10,
      }),
      extract: (text) => createReadabilityExtractorOutput(text),
      onSource,
    },
  );
  await harness.activate({
    events: { emit: () => {} },
    config: { maxHits: 6, maxFetches: 3 },
  } as unknown as Parameters<typeof createResearchHarness>[0]);
  return harness.run({ ownerId, question });
}
export function createReadabilityExtractorOutput(
  text: string,
): Array<{ text: string; status: "ok" | "partial" }> {
  const extractor = createReadabilityExtractor();
  extractor.activate({
    pluginName: "extract-readability",
    kind: "extractor",
    config: {},
    logger: { info: () => {}, warn: () => {} },
    network: { assertHostAllowed: () => {} },
    secrets: { assertNameAllowed: () => {}, resolve: async () => "" },
    events: { emit: () => {} },
  } as unknown as Parameters<ReturnType<typeof createReadabilityExtractor>["activate"]>[0]);
  return extractor.extract(text);
}
export function makeAuth(devBypass: boolean): AuthService {
  return new AuthService(new StaticOidcVerifier({ "token-alice": ALICE }), {
    allowlist: ["owner-alice"],
    devBypass,
    devOwner: "owner-alice",
  });
}
export function baseUrl(): string {
  return `http://127.0.0.1:${port}`;
}
export interface SseEvent {
  event: string;
  data: unknown;
}
export function parseSse(raw: string): SseEvent[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/);
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      if (event === undefined || data === undefined) return null;
      return { event, data: JSON.parse(data) as unknown };
    })
    .filter((e): e is SseEvent => e !== null);
}
export async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
export async function rawGetStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}
export async function rawGetWithBody(port: number, path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "content-length": String(Buffer.byteLength(body)) },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          settled = true;
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(body);
  });
}
beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  await client.execute({
    sql: "INSERT INTO owners (id, display_name, created_at) VALUES ('owner-alice', 'Alice', '2026-09-10T00:00:00Z') ON CONFLICT(id) DO NOTHING",
  });
  server = createResearchServer({
    auth: makeAuth(true), // dev bypass ON: loopback requests act as owner-alice
    runResearch,
    answer: async (ownerId, question) => {
      if (question === "boom") throw new Error("model exploded");
      ownerSeen = ownerId;
      return {
        requestId: "req-ans-1",
        answerId: "ans-1",
        cached: false,
        degraded: false,
        evidenceOnly: false,
        blocks: [{ kind: "paragraph", text: "Grounded claim.", citations: ["ev-1"] }],
      };
    },
  });
  port = await listen(server);
});
afterAll(() => {
  server.close();
});
