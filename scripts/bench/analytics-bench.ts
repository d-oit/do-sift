/**
 * Baseline analytics benchmark (#154, plans 046 + 057).
 *
 * Generates a deterministic dataset, stores it in an in-memory libSQL
 * database, and measures the aggregation work the offline reports need. The
 * DuckDB comparison is **not** run here: adding the native dependency is a
 * promotion decision (ADR 0013). The output records enough environment and
 * dataset metadata for a future run to be comparable, repeat runs report
 * p50/p95 variance instead of hiding it, and an opt-in `--disk` mode measures
 * on-disk storage size for the same dataset.
 *
 * This is a spike-level harness: it never writes to the operational database
 * and never runs in the request path.
 */
import { createRequire } from "node:module";
import { readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import os from "node:os";
import { createClient, type Client } from "@libsql/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const require = createRequire(import.meta.url);
function libsqlClientVersion(): string {
  // `@libsql/client/package.json` is not an exported subpath, so resolve the
  // module entry and walk up to its real package.json.
  let dir = dirname(require.resolve("@libsql/client"));
  for (let i = 0; i < 5; i++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === "@libsql/client") return manifest.version ?? "unknown";
    } catch {
      // not the package root; keep walking up
    }
    dir = dirname(dir);
  }
  return "unknown";
}
const libsqlVersion: string = libsqlClientVersion();

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

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

const AGGREGATE_QUERY = `
    SELECT provider, dataset, COUNT(*) AS n, AVG(recall) AS mean_recall,
           MIN(recall) AS min_recall, MAX(recall) AS max_recall,
           AVG(latency_ms) AS mean_latency
    FROM eval_results GROUP BY provider, dataset ORDER BY provider, dataset`;

async function load(client: Client, rows: number, seed: number): Promise<number> {
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
  return Date.now() - start;
}

type DiskMode = "off" | "also" | "only";

async function run(rows: number, seed: number, runs: number, diskMode: DiskMode): Promise<number> {
  const useMemory = diskMode !== "only";
  const measureDisk = diskMode !== "off";
  const engine = diskMode === "only" ? "libsql/sqlite (on-disk)" : "libsql/sqlite (in-memory)";
  const dbPath = join(tmpdir(), `analytics-bench-${process.pid}-${seed}.db`);

  let memoryClient: Client | null = null;
  let loadMs: number | null = null;
  let diskClient: Client | null = null;
  let diskLoadMs: number | null = null;
  const queryMs: number[] = [];
  let resultRows: Array<Record<string, unknown>> = [];
  let resultsIdentical = true;
  let diskBytes: number | null = null;
  if (!useMemory && !measureDisk) throw new Error("unreachable disk mode");
  try {
    if (useMemory) {
      memoryClient = createClient({ url: ":memory:" });
      loadMs = await load(memoryClient, rows, seed);
    }
    if (measureDisk) {
      diskClient = createClient({ url: `file:${dbPath}` });
      diskLoadMs = await load(diskClient, rows, seed);
    }
    const queryClient: Client = (useMemory ? memoryClient : diskClient) as Client;

    // First timed run is cold (fresh connection, cold page cache in-process);
    // the remaining runs are warm. Results must be identical across runs.
    for (let i = 0; i < runs; i++) {
      const queryStart = Date.now();
      const result = await queryClient.execute(AGGREGATE_QUERY);
      queryMs.push(Date.now() - queryStart);
      const serialized = JSON.stringify(result.rows.map((row) => ({ ...row })));
      if (i === 0) {
        resultRows = JSON.parse(serialized) as Array<Record<string, unknown>>;
      } else if (serialized !== JSON.stringify(resultRows)) {
        resultsIdentical = false;
      }
    }
    queryClient.close();
    if (useMemory) memoryClient = null;
    else diskClient = null;

    if (measureDisk) diskBytes = statSync(dbPath).size;
  } finally {
    memoryClient?.close();
    diskClient?.close();
    if (measureDisk) rmSync(dbPath, { force: true });
  }

  const sorted = [...queryMs].sort((a, b) => a - b);
  const warmSorted = sorted.slice(1);

  console.log(
    JSON.stringify(
      {
        benchmark: "analytics-baseline",
        engine,
        rows,
        seed,
        runs,
        groups: resultRows.length,
        result: resultRows,
        resultsIdentical,
        loadMs,
        coldQueryMs: queryMs[0] ?? null,
        warmQueryMs: queryMs.slice(1),
        queryMsP50: percentile(sorted, 0.5),
        queryMsP95: percentile(sorted, 0.95),
        warmQueryMsP50: percentile(warmSorted, 0.5),
        disk: measureDisk ? { loadMs: diskLoadMs, sizeBytes: diskBytes } : null,
        maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: os.cpus()[0]?.model ?? "unknown",
        totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
        libsql: libsqlVersion,
        duckdb: "not installed (promotion gate: plans/046)",
      },
      null,
      2,
    ),
  );
  return resultsIdentical ? 0 : 1;
}

function parseDiskMode(): DiskMode {
  const only = process.argv.includes("--disk-only");
  const also = process.argv.includes("--disk");
  if (only && also) {
    console.error("bench: FAIL — --disk and --disk-only are mutually exclusive");
    process.exit(1);
  }
  return only ? "only" : also ? "also" : "off";
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
const runs = Number(arg("runs") ?? "3");
if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
  console.error("bench: FAIL — --runs must be an integer from 1 to 100");
  process.exit(1);
}
process.exit(await run(rows, seed, runs, parseDiskMode()));
