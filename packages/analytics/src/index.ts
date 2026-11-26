/**
 * Offline analytics over stored evaluation rows (plan 046, ADR 0013).
 *
 * DuckDB is used **only** here: this package is not imported by the server
 * startup path, contracts, plugins, or request handlers, and it never appears
 * in the request path. The operational source of truth stays libSQL/SQLite;
 * callers pass an explicit array of rows, so there is no second writer and no
 * shared file. The database is always `:memory:` with a fixed aggregation
 * query; callers cannot supply SQL or file paths.
 *
 * Resource bounds (issue #156, plan 058): `aggregateEvalResults` caps input
 * rows (`maxRows`, default 200_000) and races the operation against a timeout
 * (`timeoutMs`, default 30_000ms) plus an optional `AbortSignal`. Abort is
 * cooperative — the DuckDB JS binding has no mid-query abort, so an abort
 * surfaces at the next checkpoint, not mid-scan.
 *
 * Missing-binding fallback (issue #156, plan 059): DuckDB is loaded with a
 * dynamic import, so a host without the native binding still imports this
 * package and aggregates via the pure-TS `aggregateJs` (same grouping and
 * statistics). `DO_SIFT_ANALYTICS_ENGINE=javascript` forces the fallback
 * for tests and binding-less hosts; anything else tries DuckDB first.
 *
 * Platform: `@duckdb/node-api` prebuilt binaries cover the repo CI matrix
 * (Linux 24/26, macOS 24, Windows 24 x64); Windows arm64 has no binding and
 * is unsupported. The dependency stays in this package only; upgrades move
 * only by decision with the matrix re-verified, never by drift.
 *
 * The aggregation is identical to `scripts/bench/analytics-bench.ts`, which is
 * what the adoption gate measured.
 */
export {
  buildRetrievalReport,
  MIN_PERCENTILE_N,
  REPORT_VERSION,
  type ReportProvenance,
  type RetrievalGroup,
  type RetrievalReport,
} from "./report.js";
export {
  buildSourceQualityReport,
  SOURCE_QUALITY_REPORT_VERSION,
  type DomainBucket,
  type NoiseBucket,
  type SourceDocumentRow,
  type SourcePassageRow,
  type SourceQualityReport,
  type StatusBucket,
  type YearMonthBucket,
} from "./source-quality.js";
export {
  buildProviderHealthReport,
  MIN_LATENCY_SAMPLE_N,
  PROVIDER_HEALTH_REPORT_VERSION,
  type ProviderCallRow,
  type ProviderFailureKind,
  type ProviderGroup,
  type ProviderHealthReport,
  type ProviderOutcome,
  type VerifiedProviderCost,
} from "./provider-health.js";

// No static DuckDB import: the binding is loaded dynamically so a missing
// native package is a supported configuration with a pure-TS fallback
// (issue #156, plan 059), not an import-time crash.

export interface EvalResultRow {
  id: string;
  provider: string;
  dataset: string;
  /** Recall in 0..1, as stored by the evaluation harness. */
  recall: number;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
  /** UTC day (`YYYY-MM-DD`). */
  createdDay: string;
}

export interface EvalAggregate {
  provider: string;
  dataset: string;
  n: number;
  meanRecall: number;
  minRecall: number;
  maxRecall: number;
  meanLatency: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function assertRow(row: EvalResultRow): void {
  if (row.id.trim() === "") throw new Error("analytics row id must not be empty");
  if (row.provider.trim() === "") throw new Error(`analytics row ${row.id}: provider is empty`);
  if (row.dataset.trim() === "") throw new Error(`analytics row ${row.id}: dataset is empty`);
  if (!Number.isFinite(row.recall) || row.recall < 0 || row.recall > 1) {
    throw new Error(`analytics row ${row.id}: recall must be between 0 and 1`);
  }
  if (!Number.isInteger(row.latencyMs) || row.latencyMs < 0) {
    throw new Error(`analytics row ${row.id}: latencyMs must be a non-negative integer`);
  }
  if (!DAY.test(row.createdDay)) {
    throw new Error(`analytics row ${row.id}: createdDay must be YYYY-MM-DD`);
  }
}

/**
 * Bounds for offline aggregation (issue #156, plan 058).
 *
 * - `maxRows` caps caller-supplied input before DuckDB sees it. Default
 *   200_000 sits above the 100k adopt gate and below the 250k+ memory climb
 *   measured in plan 057.
 * - `timeoutMs` guards the whole operation. Default 30_000ms: the 500k
 *   aggregate completes in <1s on the plan 057 sandbox, so the timeout is a
 *   guard rail, not a budget.
 * - `signal` is cooperative: the DuckDB JS binding exposes no mid-query
 *   abort, so an abort raised mid-query surfaces at the next checkpoint
 *   (before DuckDB startup, before the aggregate query, after it).
 */
export interface AggregateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRows?: number;
}

export const DEFAULT_ANALYTICS_MAX_ROWS = 200_000;
export const DEFAULT_ANALYTICS_TIMEOUT_MS = 30_000;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("analytics aggregation aborted");
}

/**
 * Pure-TypeScript aggregation with the same deterministic grouping as the
 * DuckDB path: groups by (provider, dataset), sorted by provider then
 * dataset. Used when DuckDB is unavailable and when
 * `DO_SIFT_ANALYTICS_ENGINE=javascript` forces the fallback (plan 059).
 */
export function aggregateJs(rows: readonly EvalResultRow[]): EvalAggregate[] {
  const seen = new Set<string>();
  for (const row of rows) {
    assertRow(row);
    if (seen.has(row.id)) throw new Error(`analytics row id is duplicated: ${row.id}`);
    seen.add(row.id);
  }
  const groups = new Map<string, EvalResultRow[]>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.dataset}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  return [...groups.values()]
    .sort((a, b) => {
      const firstA = a[0];
      const firstB = b[0];
      if (firstA === undefined || firstB === undefined) return 0;
      if (firstA.provider !== firstB.provider) return firstA.provider < firstB.provider ? -1 : 1;
      return firstA.dataset < firstB.dataset ? -1 : firstA.dataset > firstB.dataset ? 1 : 0;
    })
    .map((list) => {
      const first = list[0];
      if (first === undefined) throw new Error("analytics group is empty");
      const recalls = list.map((item) => item.recall);
      return {
        provider: first.provider,
        dataset: first.dataset,
        n: list.length,
        meanRecall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
        minRecall: Math.min(...recalls),
        maxRecall: Math.max(...recalls),
        meanLatency: list.reduce((sum, item) => sum + item.latencyMs, 0) / list.length,
      };
    });
}

/** DuckDB is forced off only by the exact `javascript` value; anything else
 * (including unset) means "try DuckDB first, fall back on import failure". */
function isJsForced(): boolean {
  return process.env["DO_SIFT_ANALYTICS_ENGINE"] === "javascript";
}

/**
 * Aggregate provider/dataset recall and latency. DuckDB (`:memory:`, fixed
 * SQL) is the default engine; a missing binding falls back to the pure-TS
 * `aggregateJs` with identical grouping. Deterministic: the same rows
 * produce the same groups regardless of input order.
 */
export async function aggregateEvalResults(
  rows: readonly EvalResultRow[],
  options?: AggregateOptions,
): Promise<EvalAggregate[]> {
  const maxRows = options?.maxRows ?? DEFAULT_ANALYTICS_MAX_ROWS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_ANALYTICS_TIMEOUT_MS;
  const signal = options?.signal;
  if (!Number.isInteger(maxRows) || maxRows < 0) {
    throw new Error("analytics maxRows must be a non-negative integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("analytics timeoutMs must be a non-negative number");
  }
  throwIfAborted(signal);
  if (rows.length > maxRows) {
    throw new Error(`analytics row count ${rows.length} exceeds limit ${maxRows}`);
  }
  if (timeoutMs === 0) {
    throw new Error("analytics aggregation timed out after 0ms");
  }

  return withBounds(signal, timeoutMs, async () => {
    const seen = new Set<string>();
    for (const row of rows) {
      assertRow(row);
      if (seen.has(row.id)) throw new Error(`analytics row id is duplicated: ${row.id}`);
      seen.add(row.id);
    }
    throwIfAborted(signal);
    if (isJsForced()) return aggregateJs(rows);

    let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance;
    try {
      ({ DuckDBInstance } = await import("@duckdb/node-api"));
    } catch {
      return aggregateJs(rows);
    }

    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run(`
      CREATE TABLE eval_results (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        dataset TEXT NOT NULL,
        recall DOUBLE NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_day TEXT NOT NULL
      )`);
      if (rows.length > 0) {
        const appender = await connection.createAppender("eval_results");
        for (const row of rows) {
          appender.appendVarchar(row.id);
          appender.appendVarchar(row.provider);
          appender.appendVarchar(row.dataset);
          appender.appendDouble(row.recall);
          appender.appendInteger(row.latencyMs);
          appender.appendVarchar(row.createdDay);
          appender.endRow();
        }
        appender.flushSync();
        appender.closeSync();
      }

      throwIfAborted(signal);
      const reader = await connection.runAndReadAll(`
      SELECT provider, dataset, COUNT(*) AS n, AVG(recall) AS mean_recall,
             MIN(recall) AS min_recall, MAX(recall) AS max_recall,
             AVG(latency_ms) AS mean_latency
      FROM eval_results GROUP BY provider, dataset ORDER BY provider, dataset`);
      throwIfAborted(signal);

      return reader.getRowObjects().map((row) => ({
        provider: String(row["provider"]),
        dataset: String(row["dataset"]),
        n: Number(row["n"]),
        meanRecall: Number(row["mean_recall"]),
        minRecall: Number(row["min_recall"]),
        maxRecall: Number(row["max_recall"]),
        meanLatency: Number(row["mean_latency"]),
      }));
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
}

/** Race the task against a timeout and an AbortSignal; always clears timers. */
function withBounds<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`analytics aggregation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          onAbort = () => {
            reject(new Error("analytics aggregation aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
  const pending: Array<Promise<never>> = [timeoutPromise];
  if (abortPromise !== undefined) pending.push(abortPromise);
  return (async () => {
    try {
      return await Promise.race([task(), ...pending]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  })();
}
