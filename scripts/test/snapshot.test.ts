import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotContractError,
  assertSnapshotCompatible,
  buildSnapshotManifest,
  normalizeSnapshot,
  snapshotChecksum,
  type SnapshotRecord,
} from "@do-sift/contracts";

function record(over: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    runId: "run-1",
    fixtureId: "q-1",
    datasetVersion: "2026-11",
    mode: "search",
    configuration: { provider: "wikipedia", ranker: "bm25" },
    metrics: { "retrieval.recallAtK": 0.8, "retrieval.mrr": 0.5 },
    observedAt: "2026-11-17T00:00:00.000Z",
    ...over,
  };
}

describe("snapshot contract", () => {
  it("canonicalizes record order and metric key order", () => {
    const a = normalizeSnapshot([
      record({ runId: "run-2", fixtureId: "q-2" }),
      record({ metrics: { "retrieval.mrr": 0.5, "retrieval.recallAtK": 0.8 } }),
    ]);
    expect(a.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
    expect(Object.keys(a[0]?.metrics ?? {})).toEqual(["retrieval.mrr", "retrieval.recallAtK"]);
    expect(snapshotChecksum(a)).toBe(snapshotChecksum([...a].reverse()));
  });

  it("builds a manifest whose checksum and row count describe the dataset", () => {
    const records = [record(), record({ runId: "run-2" })];
    const manifest = buildSnapshotManifest(records, {
      datasetVersion: "2026-11",
      codeRevision: "abc123",
    });
    expect(manifest.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(manifest.rowCount).toBe(2);
    expect(manifest.createdAt).toBe("2026-11-17T00:00:00.000Z");
    expect(() => assertSnapshotCompatible(manifest, records)).not.toThrow();
  });

  it("refuses an empty dataset and a checksum mismatch", () => {
    expect(() => buildSnapshotManifest([], { datasetVersion: "x", codeRevision: "y" })).toThrow(
      SnapshotContractError,
    );
    const records = [record()];
    const manifest = buildSnapshotManifest(records, {
      datasetVersion: "2026-11",
      codeRevision: "abc123",
    });
    expect(() =>
      assertSnapshotCompatible(manifest, [record({ metrics: { "retrieval.mrr": 0 } })]),
    ).toThrow(SnapshotContractError);
  });

  it("rejects an unknown schema version with the expected version named", () => {
    const manifest = buildSnapshotManifest([record()], {
      datasetVersion: "2026-11",
      codeRevision: "abc123",
    });
    expect(() => assertSnapshotCompatible({ ...manifest, schemaVersion: 999 }, [record()])).toThrow(
      /unsupported snapshot schema 999/u,
    );
  });

  it("rejects a record that does not match the manifest dataset", () => {
    const records = [record()];
    const manifest = buildSnapshotManifest(records, {
      datasetVersion: "2026-11",
      codeRevision: "abc123",
    });
    expect(() =>
      assertSnapshotCompatible(manifest, [record({ datasetVersion: "2026-12" })]),
    ).toThrow(/does not match manifest/u);
  });
});
