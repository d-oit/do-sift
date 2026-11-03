/**
 * Degradation-honesty suite runner (issue #127). Each scenario in
 * evals/degradation/scenarios.json injects one failure into the REAL answer
 * path — an in-memory database, the research harness, the answer service, and
 * the HTTP surface — then asserts three things: the exact user-facing message,
 * the operational event receipt (`answer.degraded` / `http.request`), and the
 * persisted state (request status, stored answers, cache key, budget ledger).
 *
 * Deterministic and offline except for loopback HTTP: fake search/model
 * providers, no external fetches, no paid model calls. The quality gate's
 * degradation-honesty score is the fraction of scenarios whose every check
 * held; scripts/eval.ts enforces 1.0 under `npm run check`.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { AuthService, StaticOidcVerifier } from "@do-sift/auth";
import type { SearchProvider } from "@do-sift/contracts";
import { FakeModelProvider, FakeSearchProvider } from "@do-sift/fake-providers";
import { createResearchHarness } from "@do-sift/plugin-harness-research";
import {
  ANSWER_BASIS_MESSAGES,
  ANSWER_CACHED_PREFIX,
  ANSWER_EVIDENCE_ONLY_MESSAGE,
  ANSWER_FAILED_MESSAGE,
  ANSWER_GROUNDED_MESSAGE,
  ANSWER_PARTIAL_MESSAGE,
  ANSWER_UNRESOLVED_LABEL,
  DEFAULT_PAGE,
  createAnswerService,
  createResearchServer,
  listen,
  type AnswerHttpResponse,
  type HttpRequestEvent,
  type OperationalEvent,
  type ResearchServerOptions,
} from "@do-sift/server";
import { BudgetService, Repositories, applyMigrations, loadMigrations } from "@do-sift/storage";
import { createClient, type Client } from "@libsql/client";
import { DEGRADATION_RECEIPT_REASONS, type DegradationReceiptReason } from "./history.js";

const ROOT = process.cwd();
const OWNER_ID = "degradation-owner";
const CAPS = {
  maxInputTokens: 20_000,
  maxOutputTokens: 10_000,
  maxSearchCalls: 100,
  maxFetches: 100,
};
const PAGE_TEXT = [
  "The 2026 orbiter found water ice beneath the northern basin during its survey.",
  "The orbiter's spectrometer measured water ice and carbon dioxide frost in the same region.",
].join("\n\n");

type Injection =
  | "search-empty"
  | "search-timeout"
  | "model-failure"
  | "storage-full"
  | "evidence-failure"
  | "citation-invalid"
  | "partial-citation"
  | "cross-question";

type ResearchMode = "none" | "empty" | "seed" | "cross-question" | "fails" | "storage-full";

interface ScenarioExpectation {
  research: ResearchMode;
  answerStatus: number;
  userMessage: string;
  degraded: boolean | null;
  evidenceOnly: boolean | null;
  blockCount: number | null;
  unresolvedClaims?: number | null;
  evidenceFromRun: "run" | "legacy" | "cross-question" | null;
  modelCalls: number;
  requestStatus: "completed" | "failed";
  answersStored: number;
  cacheKeyStored: boolean | null;
  openReservations: number;
  event: {
    type: "answer.degraded";
    reason: "no-evidence" | "citation-invalid" | "model-failed";
  } | null;
  http: { path: string; status: number; outcome: string };
  retry: { cached: boolean; modelCalls: number } | null;
}

interface ScenarioDefinition {
  id: string;
  name: string;
  question: string;
  seedQuestion?: string;
  injection: Injection;
  expect: ScenarioExpectation;
}

interface ScenarioDataset {
  schemaVersion: number;
  suiteVersion: string;
  description: string;
  scenarios: ScenarioDefinition[];
}

export interface DegradationCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface DegradationScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  /** Expected honest-degradation receipt, or null when the scenario expects no event. */
  reason: "no-evidence" | "citation-invalid" | "model-failed" | null;
  /** Expected evidence-only flag; null when the scenario expects a hard failure. */
  degraded: boolean | null;
  /** Receipt reason the run actually emitted, or null when it emitted none. */
  receiptReason: DegradationReceiptReason | null;
  checks: DegradationCheck[];
}

export interface DegradationSuiteResult {
  suiteVersion: string;
  total: number;
  passed: number;
  /** Quality gate dimension: passed scenarios / registered scenarios. */
  degradationHonesty: number;
  scenarios: DegradationScenarioResult[];
}

function isReceiptReason(value: unknown): value is DegradationReceiptReason {
  return DEGRADATION_RECEIPT_REASONS.includes(value as DegradationReceiptReason);
}

const INJECTIONS: readonly Injection[] = [
  "search-empty",
  "search-timeout",
  "model-failure",
  "storage-full",
  "evidence-failure",
  "citation-invalid",
  "partial-citation",
  "cross-question",
];

/** The quality gate's degradation-honesty score, with a fail-closed denominator. */
export function computeDegradationHonesty(passed: number, total: number): number {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error("degradation suite must register at least one scenario (INV-006 spirit)");
  }
  if (!Number.isInteger(passed) || passed < 0 || passed > total) {
    throw new Error(`degradation pass count ${passed} is outside 0..${total}`);
  }
  return passed / total;
}

function loadDataset(): ScenarioDataset {
  const path = join(ROOT, "evals", "degradation", "scenarios.json");
  if (!existsSync(path)) throw new Error(`degradation suite dataset missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ScenarioDataset;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`degradation suite schemaVersion must be 1 (got ${parsed.schemaVersion})`);
  }
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length < 5) {
    throw new Error("degradation suite must register at least five scenarios");
  }
  const ids = new Set<string>();
  for (const scenario of parsed.scenarios) {
    if (typeof scenario.id !== "string" || scenario.id.trim().length === 0) {
      throw new Error("degradation scenario has no id");
    }
    if (ids.has(scenario.id)) throw new Error(`duplicate degradation scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!INJECTIONS.includes(scenario.injection)) {
      throw new Error(`scenario ${scenario.id} has unknown injection: ${scenario.injection}`);
    }
    if (scenario.expect === undefined) {
      throw new Error(`scenario ${scenario.id} has no expectations`);
    }
  }
  return parsed;
}

function makeSearch(injection: Injection): SearchProvider {
  if (injection === "search-timeout") {
    return {
      name: "fixture-timeout",
      search: async () => {
        throw new Error("search provider timeout");
      },
    };
  }
  if (injection === "search-empty") return new FakeSearchProvider({ hits: [] });
  return new FakeSearchProvider({
    hits: [{ url: "https://evidence.test/orbiter", title: "Orbiter report", snippet: "orbiter" }],
  });
}

function makeModel(injection: Injection): FakeModelProvider {
  if (injection === "model-failure") {
    return new FakeModelProvider({ failWith: new Error("model synthesis failed") });
  }
  if (injection === "citation-invalid") {
    return new FakeModelProvider({ citationBehavior: "hallucinate" });
  }
  if (injection === "partial-citation") {
    return new FakeModelProvider({ citationBehavior: "partial-hallucinate" });
  }
  return new FakeModelProvider();
}

function failingAnswerStorage(repos: Repositories): Repositories {
  const patch = Object.create(repos) as Repositories;
  Object.assign(patch, {
    answers: {
      ...repos.answers,
      insert: async () => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    },
  });
  return patch;
}

function failingEvidenceStorage(repos: Repositories): Repositories {
  const patch = Object.create(repos) as Repositories;
  Object.assign(patch, {
    documents: {
      ...repos.documents,
      insert: async () => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    },
  });
  return patch;
}

/** Mirror the shipped page's copy so the suite asserts the message users see. */
export function describeAnswer(payload: AnswerHttpResponse): string {
  const basis =
    payload.evidenceFromRun === undefined ? "" : ANSWER_BASIS_MESSAGES[payload.evidenceFromRun];
  return (
    (payload.cached ? ANSWER_CACHED_PREFIX : "") +
    (payload.evidenceOnly
      ? ANSWER_EVIDENCE_ONLY_MESSAGE
      : payload.degraded
        ? ANSWER_PARTIAL_MESSAGE
        : ANSWER_GROUNDED_MESSAGE) +
    basis
  );
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? String(value);
}

function addCheck(
  checks: DegradationCheck[],
  name: string,
  ok: boolean,
  expected: unknown,
  actual: unknown,
): void {
  checks.push({ name, ok, expected: describeValue(expected), actual: describeValue(actual) });
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): SseEvent[] {
  return raw.split(/\r?\n\r?\n/u).flatMap((chunk) => {
    const lines = chunk.split(/\r?\n/u);
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (event === undefined || data === undefined) return [];
    return [{ event, data: JSON.parse(data) as Record<string, unknown> }];
  });
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function waitForEvent(
  events: OperationalEvent[],
  predicate: (event: OperationalEvent) => boolean,
): Promise<OperationalEvent | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = events.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

function isHttpEvent(event: OperationalEvent): event is HttpRequestEvent {
  return event.type === "http.request";
}

async function count(client: Client, sql: string): Promise<number> {
  const res = await client.execute({ sql, args: [OWNER_ID] });
  return Number(res.rows[0]?.n ?? 0);
}

async function runScenario(def: ScenarioDefinition): Promise<DegradationScenarioResult> {
  const checks: DegradationCheck[] = [];
  const client = createClient({ url: ":memory:" });
  const events: OperationalEvent[] = [];
  let server: Server | undefined;
  let receiptReason: DegradationReceiptReason | null = null;
  try {
    await applyMigrations(client, loadMigrations(join(ROOT, "migrations")));
    const repos = new Repositories(client);
    await repos.owners.ensure(OWNER_ID, "Degradation Suite");
    const budget = new BudgetService(client, CAPS);
    const model = makeModel(def.injection);
    const ctx = {
      events: { emit: () => {} },
      config: {},
    } as unknown as Parameters<typeof createResearchHarness>[0];
    const harnessRepos =
      def.injection === "evidence-failure" ? failingEvidenceStorage(repos) : repos;
    const harness = createResearchHarness(ctx, {
      search: makeSearch(def.injection),
      fetchPage: async () => ({ text: PAGE_TEXT, contentType: "text/html" }),
      repositories: harnessRepos,
      budget,
    });
    await harness.activate({
      events: { emit: () => {} },
      config: { maxHits: 6, maxFetches: 3 },
    } as unknown as Parameters<typeof harness.activate>[0]);

    const answerRepos = def.injection === "storage-full" ? failingAnswerStorage(repos) : repos;
    const answers = createAnswerService({ client, repositories: answerRepos, model, budget });
    const auth = new AuthService(new StaticOidcVerifier({}), {
      allowlist: [OWNER_ID],
      devBypass: true,
      devOwner: OWNER_ID,
    });
    const options: ResearchServerOptions = {
      auth,
      runResearch: async (ownerId, question, onSource, signal) => {
        const summary = await harness.run({ ownerId, question, onSource }, signal);
        return {
          hits: summary.hits,
          documentsStored: summary.documentsStored,
          documentsReused: summary.documentsReused,
          passagesStored: summary.passagesStored,
          denied: summary.denied,
          fetchErrors: summary.fetchErrors,
          skippedBudget: summary.skippedBudget,
          ...(summary.providerHealth === undefined
            ? {}
            : { providerHealth: summary.providerHealth }),
        };
      },
      answer: async (ownerId, question, signal) => {
        const outcome = await answers.answer({ ownerId, question }, signal);
        const stored = await repos.answers.get(ownerId, outcome.answerId);
        if (stored === undefined) {
          throw new Error(`stored answer ${outcome.answerId} not found`);
        }
        return {
          requestId: outcome.requestId,
          answerId: outcome.answerId,
          cached: outcome.cached,
          degraded: outcome.degraded,
          evidenceOnly: outcome.evidenceOnly,
          ...(outcome.degradationReason === undefined
            ? {}
            : { degradationReason: outcome.degradationReason }),
          ...(outcome.evidenceFromRun === undefined
            ? {}
            : { evidenceFromRun: outcome.evidenceFromRun }),
          blocks: stored.blocks,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          ...(outcome.reconciliation === undefined
            ? {}
            : { reconciliation: outcome.reconciliation }),
          ...(outcome.suspectEvidence === undefined
            ? {}
            : { suspectEvidence: outcome.suspectEvidence }),
        };
      },
      onEvent: (event) => events.push(event),
    };
    server = createResearchServer(options);
    const port = await listen(server);

    // ---- research phase: seed evidence, empty results, or an honest failure
    if (def.expect.research !== "none") {
      const researchQuestion = def.seedQuestion ?? def.question;
      const research = await postJson(port, "/api/research", { question: researchQuestion });
      addCheck(checks, "research HTTP status", research.status === 200, 200, research.status);
      const sse = parseSse(research.text);
      if (def.expect.research === "fails") {
        const errorEvent = sse.find((event) => event.event === "error");
        addCheck(
          checks,
          "research failure is reported",
          errorEvent?.data.message === "research failed",
          "research failed",
          errorEvent?.data.message ?? "no error event",
        );
        const httpEvent = await waitForEvent(
          events,
          (event) => isHttpEvent(event) && event.path === "/api/research" && event.status === 200,
        );
        addCheck(
          checks,
          "research failure receipt",
          httpEvent !== undefined && isHttpEvent(httpEvent) && httpEvent.outcome === "server_error",
          "server_error",
          httpEvent !== undefined && isHttpEvent(httpEvent) ? httpEvent.outcome : "no event",
        );
        const documents = await count(
          client,
          "SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?",
        );
        addCheck(checks, "no evidence stored after failure", documents === 0, 0, documents);
      } else {
        const done = sse.find((event) => event.event === "done");
        addCheck(checks, "research done event", done !== undefined, "done", done?.event ?? "none");
        if (def.expect.research === "empty" || def.expect.research === "storage-full") {
          addCheck(
            checks,
            "research stored no sources",
            done?.data.documentsStored === 0,
            0,
            done?.data.documentsStored,
          );
          addCheck(
            checks,
            "research stored no passages",
            done?.data.passagesStored === 0,
            0,
            done?.data.passagesStored,
          );
          if (def.expect.research === "storage-full") {
            // Evidence storage rejected the write: the run reports the failed
            // fetch instead of counting a source it never stored.
            addCheck(
              checks,
              "research recorded the storage failure",
              done?.data.fetchErrors === 1,
              1,
              done?.data.fetchErrors,
            );
            const storedDocuments = await count(
              client,
              "SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?",
            );
            addCheck(
              checks,
              "no evidence persisted after the storage failure",
              storedDocuments === 0,
              0,
              storedDocuments,
            );
          }
        } else {
          const passages = Number(done?.data.passagesStored ?? 0);
          addCheck(checks, "research stored evidence", passages > 0, "> 0", passages);
        }
      }
    }

    // ---- answer phase
    const response = await postJson(port, "/api/answer", { question: def.question });
    const payload =
      response.status === 200 ? (JSON.parse(response.text) as AnswerHttpResponse) : undefined;
    const expected = def.expect;
    addCheck(
      checks,
      "answer HTTP status",
      response.status === expected.answerStatus,
      expected.answerStatus,
      response.status,
    );
    if (response.status !== expected.answerStatus) {
      addCheck(checks, "answer body", false, "matching status", response.text);
    }

    const userMessage = payload === undefined ? ANSWER_FAILED_MESSAGE : describeAnswer(payload);
    addCheck(
      checks,
      "user-facing message",
      userMessage === expected.userMessage,
      expected.userMessage,
      userMessage,
    );
    // The expected copy is composed from the shipped page's fragments, so a
    // page edit that changes wording must invalidate the suite.
    const shippedPieces = [
      ANSWER_CACHED_PREFIX,
      ANSWER_GROUNDED_MESSAGE,
      ANSWER_EVIDENCE_ONLY_MESSAGE,
      ANSWER_FAILED_MESSAGE,
      ANSWER_PARTIAL_MESSAGE,
      ANSWER_UNRESOLVED_LABEL,
      ...Object.values(ANSWER_BASIS_MESSAGES),
    ];
    const missingPieces = shippedPieces.filter((piece) => !DEFAULT_PAGE.includes(piece));
    addCheck(
      checks,
      "message is the shipped page copy",
      missingPieces.length === 0,
      "all pieces in DEFAULT_PAGE",
      missingPieces.length === 0 ? "all pieces in DEFAULT_PAGE" : missingPieces,
    );

    if (expected.degraded !== null) {
      addCheck(
        checks,
        "degraded flag",
        payload?.degraded === expected.degraded,
        expected.degraded,
        payload?.degraded,
      );
    }
    if (expected.evidenceOnly !== null) {
      addCheck(
        checks,
        "evidenceOnly flag",
        payload?.evidenceOnly === expected.evidenceOnly,
        expected.evidenceOnly,
        payload?.evidenceOnly,
      );
    }
    if (expected.blockCount !== null) {
      addCheck(
        checks,
        "answer block count",
        payload?.blocks.length === expected.blockCount,
        expected.blockCount,
        payload?.blocks.length,
      );
    }
    if (expected.unresolvedClaims !== undefined) {
      const unresolved = payload?.blocks.filter((block) => block.unresolved === true).length;
      addCheck(
        checks,
        "unresolved claim count",
        unresolved === expected.unresolvedClaims,
        expected.unresolvedClaims,
        unresolved,
      );
    }
    if (expected.evidenceFromRun !== null) {
      addCheck(
        checks,
        "evidence basis",
        payload?.evidenceFromRun === expected.evidenceFromRun,
        expected.evidenceFromRun,
        payload?.evidenceFromRun,
      );
    }

    const httpEvent = await waitForEvent(
      events,
      (event) => isHttpEvent(event) && event.path === expected.http.path,
    );
    addCheck(
      checks,
      "HTTP operational receipt",
      httpEvent !== undefined &&
        isHttpEvent(httpEvent) &&
        httpEvent.status === expected.http.status &&
        httpEvent.outcome === expected.http.outcome,
      `${expected.http.status} ${expected.http.outcome}`,
      httpEvent !== undefined && isHttpEvent(httpEvent)
        ? `${httpEvent.status} ${httpEvent.outcome}`
        : "no event",
    );

    const degradedEvents = events.filter((event) => event.type === "answer.degraded");
    const receipt = degradedEvents[0];
    receiptReason =
      receipt !== undefined && isReceiptReason(receipt.reason) ? receipt.reason : null;
    if (expected.event === null) {
      addCheck(
        checks,
        "no answer.degraded receipt",
        degradedEvents.length === 0,
        "none",
        degradedEvents,
      );
    } else {
      addCheck(
        checks,
        "answer.degraded receipt",
        receipt !== undefined && receipt.reason === expected.event.reason,
        expected.event,
        receipt ?? "none",
      );
    }

    addCheck(
      checks,
      "model call count",
      model.calls.length === expected.modelCalls,
      expected.modelCalls,
      model.calls.length,
    );

    const requestRow = await client.execute({
      sql: "SELECT status FROM requests WHERE owner_id = ? AND mode = 'answer' ORDER BY rowid DESC LIMIT 1",
      args: [OWNER_ID],
    });
    const requestStatus =
      requestRow.rows[0] === undefined ? "(none)" : String(requestRow.rows[0].status);
    addCheck(
      checks,
      "answer request status",
      requestStatus === expected.requestStatus,
      expected.requestStatus,
      requestStatus,
    );

    const answersStored = await count(
      client,
      "SELECT COUNT(*) AS n FROM answers WHERE owner_id = ?",
    );
    addCheck(
      checks,
      "answers stored",
      answersStored === expected.answersStored,
      expected.answersStored,
      answersStored,
    );

    if (expected.cacheKeyStored !== null) {
      const answerRow = await client.execute({
        sql: "SELECT cache_key FROM answers WHERE owner_id = ? ORDER BY rowid DESC LIMIT 1",
        args: [OWNER_ID],
      });
      const cacheKeyStored =
        answerRow.rows[0] === undefined ? null : answerRow.rows[0].cache_key !== null;
      addCheck(
        checks,
        "cache key stored",
        cacheKeyStored === expected.cacheKeyStored,
        expected.cacheKeyStored,
        cacheKeyStored,
      );
    }

    const openReservations = await count(
      client,
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE owner_id = ? AND state = 'open'",
    );
    addCheck(
      checks,
      "no open budget reservation",
      openReservations === expected.openReservations,
      expected.openReservations,
      openReservations,
    );

    if (expected.retry !== null) {
      const retry = await postJson(port, "/api/answer", { question: def.question });
      const retryPayload =
        retry.status === 200 ? (JSON.parse(retry.text) as AnswerHttpResponse) : undefined;
      addCheck(
        checks,
        "retry is not served from cache",
        retryPayload?.cached === expected.retry.cached,
        expected.retry.cached,
        retryPayload?.cached,
      );
      addCheck(
        checks,
        "retry calls the model again",
        model.calls.length === expected.retry.modelCalls,
        expected.retry.modelCalls,
        model.calls.length,
      );
    }
  } finally {
    server?.close();
    client.close();
  }

  return {
    id: def.id,
    name: def.name,
    passed: checks.every((check) => check.ok),
    reason: def.expect.event?.reason ?? null,
    degraded: def.expect.degraded,
    receiptReason,
    checks,
  };
}

/** Run every scenario against the real answer path and score the suite. */
export async function runDegradationSuite(): Promise<DegradationSuiteResult> {
  const dataset = loadDataset();
  const scenarios: DegradationScenarioResult[] = [];
  for (const def of dataset.scenarios) {
    scenarios.push(await runScenario(def));
  }
  const passed = scenarios.filter((scenario) => scenario.passed).length;
  return {
    suiteVersion: dataset.suiteVersion,
    total: scenarios.length,
    passed,
    degradationHonesty: computeDegradationHonesty(passed, scenarios.length),
    scenarios,
  };
}
