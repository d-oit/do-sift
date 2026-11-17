/**
 * Offline analytics over stored evaluation rows (plan 046, ADR 0013).
 *
 * DuckDB is used **only** here: this package is not imported by the server,
 * contracts, plugins, or apps, and it never appears in the request path. The
 * operational source of truth stays libSQL/SQLite; callers pass an explicit
 * array of rows, so there is no second writer and no shared file.
 *
 * The aggregation is identical to `scripts/bench/analytics-bench.ts`, which is
 * what the adoption gate measured.
 */
import { DuckDBInstance } from "@duckdb/node-api";

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
 * Aggregate provider/dataset recall and latency with DuckDB. Deterministic:
 * the same rows produce the same groups regardless of input order.
 */
export async function aggregateEvalResults(
  rows: readonly EvalResultRow[],
): Promise<EvalAggregate[]> {
  const seen = new Set<string>();
  for (const row of rows) {
    assertRow(row);
    if (seen.has(row.id)) throw new Error(`analytics row id is duplicated: ${row.id}`);
    seen.add(row.id);
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

    const reader = await connection.runAndReadAll(`
      SELECT provider, dataset, COUNT(*) AS n, AVG(recall) AS mean_recall,
             MIN(recall) AS min_recall, MAX(recall) AS max_recall,
             AVG(latency_ms) AS mean_latency
      FROM eval_results GROUP BY provider, dataset ORDER BY provider, dataset`);

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
}
