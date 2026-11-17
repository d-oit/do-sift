/**
 * Deterministic offline reports (#157, ADR 0013).
 *
 * Input is a versioned evaluation snapshot (see `scripts/snapshot.ts`), not
 * live operational tables. The report groups the same metric names the eval
 * protocol defines and records dataset/schema/code versions with every
 * summary. Missing values are omitted and sample counts are always printed;
 * a mean is never presented without its n.
 *
 * No network, no credentials, no LLM. JSON output is canonical (sorted keys,
 * sorted groups) so two runs over the same snapshot are byte-identical.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SNAPSHOT_SCHEMA_VERSION,
  assertSnapshotCompatible,
  type SnapshotManifest,
  type SnapshotRecord,
} from "@do-sift/contracts";

export interface MetricSummary {
  n: number;
  mean: number;
  min: number;
  max: number;
}

export interface RetrievalGroup {
  datasetVersion: string;
  configuration: Record<string, string>;
  metrics: Record<string, MetricSummary>;
}

export interface SourceQualityReport {
  /** Records that carried at least one `source.*` metric. */
  recordsWithSourceMetrics: number;
  metrics: Record<string, MetricSummary>;
}

export interface ProviderHealthGroup {
  provider: string;
  observations: number;
  ok: number;
  degraded: number;
  failed: number;
  /** Mean latency only when at least one observation exists. */
  latencyMs?: MetricSummary;
}

export interface ReportsBundle {
  schemaVersion: number;
  snapshot: {
    schemaVersion: number;
    datasetVersion: string;
    codeRevision: string;
    createdAt: string;
    rowCount: number;
    sha256: string;
  };
  retrieval: RetrievalGroup[];
  sourceQuality: SourceQualityReport;
  providerHealth: ProviderHealthGroup[];
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function summarize(values: readonly number[]): MetricSummary {
  const n = values.length;
  return {
    n,
    mean: n === 0 ? 0 : Number((sum(values) / n).toFixed(6)),
    min: n === 0 ? 0 : Math.min(...values),
    max: n === 0 ? 0 : Math.max(...values),
  };
}

function groupMetrics(
  records: readonly SnapshotRecord[],
  predicate: (name: string) => boolean,
): Record<string, MetricSummary> {
  const buckets = new Map<string, number[]>();
  for (const record of records) {
    for (const [name, value] of Object.entries(record.metrics)) {
      if (!predicate(name)) continue;
      const bucket = buckets.get(name) ?? [];
      bucket.push(value);
      buckets.set(name, bucket);
    }
  }
  const out: Record<string, MetricSummary> = {};
  for (const name of [...buckets.keys()].sort()) {
    const values = buckets.get(name) ?? [];
    if (values.length > 0) out[name] = summarize(values);
  }
  return out;
}

export function buildReports(
  manifest: Pick<
    SnapshotManifest,
    "schemaVersion" | "datasetVersion" | "codeRevision" | "createdAt" | "rowCount" | "sha256"
  >,
  records: readonly SnapshotRecord[],
): ReportsBundle {
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported snapshot schema ${manifest.schemaVersion}; expected ${SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  if (records.length === 0) throw new Error("a report needs at least one record (INV-006)");

  const retrievalGroups = new Map<string, SnapshotRecord[]>();
  for (const record of records) {
    const key = `${record.datasetVersion}\u0000${JSON.stringify(sortedConfig(record.configuration))}`;
    const bucket = retrievalGroups.get(key) ?? [];
    bucket.push(record);
    retrievalGroups.set(key, bucket);
  }
  const retrieval: RetrievalGroup[] = [...retrievalGroups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => ({
      datasetVersion: group[0]?.datasetVersion ?? "",
      configuration: sortedConfig(group[0]?.configuration ?? {}),
      metrics: groupMetrics(group, () => true),
    }));

  const sourceQuality: SourceQualityReport = {
    recordsWithSourceMetrics: records.filter((r) =>
      Object.keys(r.metrics).some((name) => name.startsWith("source.")),
    ).length,
    metrics: groupMetrics(records, (name) => name.startsWith("source.")),
  };

  const providerMap = new Map<
    string,
    { total: number; ok: number; degraded: number; failed: number; latency: number[] }
  >();
  for (const record of records) {
    const provider = record.configuration["provider"];
    if (provider === undefined || provider === "") continue;
    const bucket = providerMap.get(provider) ?? {
      total: 0,
      ok: 0,
      degraded: 0,
      failed: 0,
      latency: [],
    };
    bucket.total += 1;
    const failure = record.metrics["provider.failures"] ?? 0;
    const degraded = record.metrics["provider.degraded"] ?? 0;
    if (failure > 0) bucket.failed += 1;
    else if (degraded > 0) bucket.degraded += 1;
    else bucket.ok += 1;
    const latency = record.metrics["provider.latencyMs"];
    if (latency !== undefined) bucket.latency.push(latency);
    providerMap.set(provider, bucket);
  }
  const providerHealth: ProviderHealthGroup[] = [...providerMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, bucket]) => ({
      provider,
      observations: bucket.total,
      ok: bucket.ok,
      degraded: bucket.degraded,
      failed: bucket.failed,
      ...(bucket.latency.length === 0 ? {} : { latencyMs: summarize(bucket.latency) }),
    }));

  return {
    schemaVersion: 1,
    snapshot: {
      schemaVersion: manifest.schemaVersion,
      datasetVersion: manifest.datasetVersion,
      codeRevision: manifest.codeRevision,
      createdAt: manifest.createdAt,
      rowCount: manifest.rowCount,
      sha256: manifest.sha256,
    },
    retrieval,
    sourceQuality,
    providerHealth,
  };
}

function sortedConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(config).sort()) {
    const value = config[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function renderReportMarkdown(bundle: ReportsBundle): string {
  const lines: string[] = [
    "# Offline reports",
    "",
    `Snapshot: dataset ${bundle.snapshot.datasetVersion}, schema ${bundle.snapshot.schemaVersion}, ` +
      `code ${bundle.snapshot.codeRevision}, ${bundle.snapshot.rowCount} rows, sha256 \`${bundle.snapshot.sha256}\`.`,
    "",
    "## Retrieval",
    "",
    "| dataset | configuration | metric | n | mean | min | max |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const group of bundle.retrieval) {
    for (const [name, m] of Object.entries(group.metrics)) {
      lines.push(
        `| ${group.datasetVersion} | ${escapeCell(JSON.stringify(group.configuration))} | ${name} | ${m.n} | ${m.mean} | ${m.min} | ${m.max} |`,
      );
    }
  }
  lines.push("", "## Source quality", "");
  lines.push(`Records with source metrics: ${bundle.sourceQuality.recordsWithSourceMetrics}.`, "");
  if (Object.keys(bundle.sourceQuality.metrics).length === 0) {
    lines.push("_No source metrics were recorded — missing data is not zero._");
  } else {
    lines.push("| metric | n | mean | min | max |", "| --- | --- | --- | --- | --- |");
    for (const [name, m] of Object.entries(bundle.sourceQuality.metrics)) {
      lines.push(`| ${name} | ${m.n} | ${m.mean} | ${m.min} | ${m.max} |`);
    }
  }
  lines.push("", "## Provider health", "");
  if (bundle.providerHealth.length === 0) lines.push("_No provider observations._");
  else {
    lines.push(
      "| provider | observations | ok | degraded | failed | latency n | latency mean |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const p of bundle.providerHealth) {
      lines.push(
        `| ${p.provider} | ${p.observations} | ${p.ok} | ${p.degraded} | ${p.failed} | ${p.latencyMs?.n ?? 0} | ${p.latencyMs?.mean ?? "unknown"} |`,
      );
    }
  }
  lines.push(
    "",
    "Observed counts only. A provider that is not listed was not measured, and a domain or",
    "provider name is descriptive — never a reliability or truth score.",
    "",
  );
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|");
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function main(): number {
  const input = arg("in");
  const outDir = arg("out-dir") ?? "evals/reports";
  if (input === undefined) throw new Error("--in <snapshot.json> is required");
  if (!existsSync(input)) throw new Error(`${input} does not exist`);

  const parsed = JSON.parse(readFileSync(input, "utf8")) as {
    manifest?: SnapshotManifest;
    records?: SnapshotRecord[];
  };
  if (parsed.manifest === undefined || !Array.isArray(parsed.records)) {
    throw new Error("snapshot must carry {manifest, records}");
  }
  assertSnapshotCompatible(parsed.manifest, parsed.records);

  const bundle = buildReports(parsed.manifest, parsed.records);
  mkdirSync(outDir, { recursive: true });
  atomicWrite(join(outDir, "reports.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  atomicWrite(join(outDir, "summary.md"), renderReportMarkdown(bundle));
  console.log(
    `reports: wrote ${bundle.retrieval.length} retrieval group(s) and ${bundle.providerHealth.length} provider(s) to ${outDir}`,
  );
  return 0;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("reports.ts") || process.argv[1].endsWith("reports.js"));

if (isEntrypoint) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`reports: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
