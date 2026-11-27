/**
 * Versioned snapshot dataset reader (issue #156, plan follow-up).
 *
 * Reads the JSON interchange datasets written by `scripts/snapshot.ts`
 * (`{manifest, records}`) and validates them against the contract in
 * `@do-sift/contracts` (`assertSnapshotCompatible`): unknown schema
 * versions, row-count mismatches, and checksum mismatches are errors,
 * never warnings. Empty datasets are refused (INV-006).
 *
 * Read-only and deterministic: the returned records are the canonical
 * normalized form, so shuffled input yields identical output. No Parquet
 * I/O — JSON interchange stays the snapshot format per the plan-052
 * deferral; a Parquet writer must preserve the same schema, manifest,
 * and checksum semantics before this reader grows a second format.
 * Nothing here touches the request path or operational tables.
 */
import {
  assertSnapshotCompatible,
  normalizeSnapshot,
  SnapshotContractError,
  type SnapshotManifest,
  type SnapshotRecord,
} from "@do-sift/contracts";

export type { SnapshotManifest, SnapshotRecord };

export interface SnapshotDataset {
  manifest: SnapshotManifest;
  records: SnapshotRecord[];
}

function isRecordArray(value: unknown): value is SnapshotRecord[] {
  return Array.isArray(value);
}

/**
 * Read and validate a snapshot dataset. Accepts the writer shape
 * `{manifest, records}` (already parsed from JSON). Returns the manifest
 * verbatim and the records in canonical normalized order.
 */
export function readSnapshotDataset(input: unknown): SnapshotDataset {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SnapshotContractError("snapshot dataset must be an object with manifest and records");
  }
  const { manifest, records } = input as { manifest?: unknown; records?: unknown };
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new SnapshotContractError("snapshot dataset must carry a manifest object");
  }
  if (!isRecordArray(records)) {
    throw new SnapshotContractError("snapshot dataset must carry a records array");
  }
  if (records.length === 0) {
    throw new SnapshotContractError("a snapshot needs at least one record (INV-006)");
  }
  const typed = manifest as SnapshotManifest;
  const normalized = normalizeSnapshot(records);
  assertSnapshotCompatible(typed, normalized);
  return { manifest: typed, records: normalized };
}
