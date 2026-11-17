/**
 * Versioned evaluation snapshot contract (issue #155, ADR 0013).
 *
 * A snapshot is an immutable, deterministic interchange artifact. It is
 * **not** an operational store: nothing reads it on the request path, and it
 * is never written back to libSQL. The JSON interchange form is implemented
 * here so it can be tested without a native dependency; a Parquet writer must
 * preserve this schema, manifest, and checksum semantics.
 */
import { createHash } from "node:crypto";

/** Bump only for an incompatible shape change. Readers reject unknown versions. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotRecord {
  /** Stable evaluation run id. */
  runId: string;
  /** Fixture/question id — never raw user question text. */
  fixtureId: string;
  datasetVersion: string;
  mode: "search" | "answer";
  /** Retrieval/provider configuration, as string key/value pairs. */
  configuration: Record<string, string>;
  /** Metric name → numeric value. Missing metrics are omitted, never zero-filled. */
  metrics: Record<string, number>;
  baselineRef?: string;
  codeRevision?: string;
  /** ISO timestamp of the observation, when the source artifact has one. */
  observedAt?: string;
}

export interface SnapshotManifest {
  schemaVersion: number;
  datasetVersion: string;
  codeRevision: string;
  /** Newest observation time in the dataset; deterministic, not "now". */
  createdAt: string;
  rowCount: number;
  /** sha256 of the canonical serialized records. */
  sha256: string;
}

export class SnapshotContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotContractError";
  }
}

function sortObject(input: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      throw new SnapshotContractError(`metric "${key}" is not a finite number`);
    }
    out[key] = value;
  }
  return out;
}

function sortConfiguration(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Canonical form: records sorted by `(runId, fixtureId, observedAt)` and
 * object keys sorted, so two logically identical inputs serialize identically.
 */
export function normalizeSnapshot(records: readonly SnapshotRecord[]): SnapshotRecord[] {
  const normalized = records.map((record) => {
    if (record.runId.trim() === "") throw new SnapshotContractError("record has an empty runId");
    if (record.fixtureId.trim() === "")
      throw new SnapshotContractError("record has an empty fixtureId");
    if (record.datasetVersion.trim() === "")
      throw new SnapshotContractError("record has an empty datasetVersion");
    const base: SnapshotRecord = {
      runId: record.runId,
      fixtureId: record.fixtureId,
      datasetVersion: record.datasetVersion,
      mode: record.mode,
      configuration: sortConfiguration(record.configuration),
      metrics: sortObject(record.metrics),
    };
    if (record.baselineRef !== undefined) base.baselineRef = record.baselineRef;
    if (record.codeRevision !== undefined) base.codeRevision = record.codeRevision;
    if (record.observedAt !== undefined) base.observedAt = record.observedAt;
    return base;
  });
  normalized.sort((a, b) => {
    if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    if (a.fixtureId !== b.fixtureId) return a.fixtureId < b.fixtureId ? -1 : 1;
    const at = a.observedAt ?? "";
    const bt = b.observedAt ?? "";
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
  return normalized;
}

/** sha256 over the canonical JSON (no whitespace variance). */
export function snapshotChecksum(records: readonly SnapshotRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeSnapshot(records)), "utf8")
    .digest("hex");
}

/**
 * Manifest for a dataset. `createdAt` is the newest observation in the data,
 * which keeps re-exports byte-identical; pass `createdAt` explicitly when the
 * artifact needs a wall-clock stamp.
 */
export function buildSnapshotManifest(
  records: readonly SnapshotRecord[],
  meta: { datasetVersion: string; codeRevision: string; createdAt?: string },
): SnapshotManifest {
  if (records.length === 0) {
    throw new SnapshotContractError("a snapshot needs at least one record (INV-006)");
  }
  if (meta.datasetVersion.trim() === "") {
    throw new SnapshotContractError("datasetVersion is required");
  }
  if (meta.codeRevision.trim() === "") {
    throw new SnapshotContractError("codeRevision is required");
  }
  const normalized = normalizeSnapshot(records);
  const observed = normalized
    .map((r) => r.observedAt)
    .filter((v): v is string => v !== undefined)
    .sort();
  const createdAt = meta.createdAt ?? observed[observed.length - 1];
  if (createdAt === undefined) {
    throw new SnapshotContractError("createdAt is required when no record carries observedAt");
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    datasetVersion: meta.datasetVersion,
    codeRevision: meta.codeRevision,
    createdAt,
    rowCount: normalized.length,
    sha256: snapshotChecksum(normalized),
  };
}

/**
 * Reject an unknown schema version or a dataset that does not match its
 * manifest. A mismatch is an error, never a warning.
 */
export function assertSnapshotCompatible(
  manifest: SnapshotManifest,
  records: readonly SnapshotRecord[],
): void {
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotContractError(
      `unsupported snapshot schema ${manifest.schemaVersion}; this reader understands ${SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  if (records.length !== manifest.rowCount) {
    throw new SnapshotContractError(
      `manifest says ${manifest.rowCount} rows, dataset has ${records.length}`,
    );
  }
  for (const record of records) {
    if (record.datasetVersion !== manifest.datasetVersion) {
      throw new SnapshotContractError(
        `record datasetVersion "${record.datasetVersion}" does not match manifest "${manifest.datasetVersion}"`,
      );
    }
  }
  const actual = snapshotChecksum(records);
  if (actual !== manifest.sha256) {
    throw new SnapshotContractError("snapshot checksum does not match its manifest");
  }
}
