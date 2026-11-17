/**
 * Baseline analytics benchmark (#154, plan 046).
 *
 * Generates a deterministic dataset, stores it in an in-memory libSQL
 * database, and measures the aggregation work the offline reports need. The
 * DuckDB comparison is **not** run here: adding the native dependency is a
 * promotion decision (ADR 0013). The output records enough environment and
 * dataset metadata for a future run to be comparable, and repeat runs report
 * variance instead of hiding it.
 *
 * This is a spike-level harness: it never writes to the operational database
 * and never runs in the request path.
 */
import { createClient } from "@libsql/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

/** Deterministic 32-bit PRNG so every run generates identical rows. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(rows: number, seed: number): Promise<number> {
  const client = createClient({ url: ":memory:" });
  const random = mulberry32(seed);
  const providers = ["alpha", "beta", "gamma"];
  const start = Date.now();
  await client.execute(`
    CREATE TABLE eval_results (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      dataset TEXT NOT NULL,
      recall REAL NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_day TEXT NOT NULL
    )`);
  // Batch the inserts: libSQL's in-memory client has one connection, so an
  // explicit BEGIN/COMMIT pair across awaited execute() calls is not a stable
  // unit of work. Chunking keeps memory bounded for the 1M-row ceiling.
  const chunk: Array<{ sql: string; args: Array<string | number> }> = [];
  for (let i = 0; i < rows; i++) {
    chunk.push({
      sql: "INSERT INTO eval_results (id, provider, dataset, recall, latency_ms, created_day) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        `r${i}`,
        providers[Math.floor(random() * providers.length)] ?? "alpha",
        `dataset-${1 + Math.floor(random() * 3)}`,
        Number(random().toFixed(4)),
        10 + Math.floor(random() * 900),
        `2026-11-${String(1 + (i % 17)).padStart(2, "0")}`,
      ],
    });
    if (chunk.length === 1000) {
      await client.batch(chunk, "write");
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) await client.batch(chunk, "write");
  const loadMs = Date.now() - start;

  const queryStart = Date.now();
  const result = await client.execute(`
    SELECT provider, dataset, COUNT(*) AS n, AVG(recall) AS mean_recall,
           MIN(recall) AS min_recall, MAX(recall) AS max_recall,
           AVG(latency_ms) AS mean_latency
    FROM eval_results GROUP BY provider, dataset ORDER BY provider, dataset`);
  const queryMs = Date.now() - queryStart;
  client.close();

  console.log(
    JSON.stringify(
      {
        benchmark: "analytics-baseline",
        engine: "libsql/sqlite (in-memory)",
        rows,
        seed,
        groups: result.rows.length,
        loadMs,
        queryMs,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        duckdb: "not installed (promotion gate: plans/046)",
      },
      null,
      2,
    ),
  );
  return 0;
}

const rawRows = arg("rows") ?? "10000";
const rows = Number(rawRows);
if (!Number.isInteger(rows) || rows < 1 || rows > 1_000_000) {
  console.error("bench: FAIL — --rows must be an integer from 1 to 1,000,000");
  process.exit(1);
}
const seed = Number(arg("seed") ?? "42");
if (!Number.isInteger(seed)) {
  console.error("bench: FAIL — --seed must be an integer");
  process.exit(1);
}
process.exit(await run(rows, seed));
