import { describe, expect, it } from "vitest";
import {
  buildSnapshotManifest,
  normalizeSnapshot,
  snapshotChecksum,
  type SnapshotManifest,
  type SnapshotRecord,
} from "@do-sift/contracts";
import { readSnapshotDataset } from "../src/snapshots.js";

function record(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    runId: "run-001",
    fixtureId: "fixture-a",
    datasetVersion: "v1",
    mode: "search",
    configuration: { provider: "wikipedia" },
    metrics: { recall: 0.5 },
    observedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function dataset(records: SnapshotRecord[]): {
  manifest: SnapshotManifest;
  records: SnapshotRecord[];
} {
  const normalized = normalizeSnapshot(records);
  const manifest = buildSnapshotManifest(normalized, {
    datasetVersion: "v1",
    codeRevision: "abc123",
  });
  return { manifest, records: normalized };
}

describe("snapshots dataset reader (JSON interchange, no Parquet I/O)", () => {
  it("round-trips a writer-shaped dataset", () => {
    const input = dataset([
      record(),
      record({ fixtureId: "fixture-b", metrics: { recall: 0.75 } }),
    ]);
    const result = readSnapshotDataset(JSON.parse(JSON.stringify(input)));
    expect(result.manifest).toEqual(input.manifest);
    expect(result.records).toEqual(input.records);
  });

  it("returns normalized records for shuffled input", () => {
    const b = record({ fixtureId: "fixture-b" });
    const a = record({ fixtureId: "fixture-a" });
    const input = dataset([a, b]);
    const shuffled = { manifest: input.manifest, records: [b, a] };
    const result = readSnapshotDataset(shuffled);
    expect(result.records.map((r) => r.fixtureId)).toEqual(["fixture-a", "fixture-b"]);
    expect(result.manifest.sha256).toBe(snapshotChecksum(result.records));
  });

  it("rejects an unknown schema version with a clear error", () => {
    const input = dataset([record()]);
    const bad = {
      manifest: { ...input.manifest, schemaVersion: 999 },
      records: input.records,
    };
    expect(() => readSnapshotDataset(bad)).toThrow(/unsupported snapshot schema 999/);
  });

  it("rejects a checksum mismatch, never a warning", () => {
    const input = dataset([record()]);
    const tampered = {
      manifest: input.manifest,
      records: [{ ...record(), metrics: { recall: 1 } }],
    };
    expect(() => readSnapshotDataset(tampered)).toThrow(/checksum/);
  });

  it("rejects a row-count mismatch", () => {
    const input = dataset([record(), record({ fixtureId: "fixture-b" })]);
    const short = { manifest: input.manifest, records: [input.records[0]] };
    expect(() => readSnapshotDataset(short)).toThrow(/1/);
  });

  it("rejects malformed top-level input", () => {
    for (const bad of [null, "nope", 42, [], {}, { manifest: null, records: [] }]) {
      expect(() => readSnapshotDataset(bad), JSON.stringify(bad)).toThrow(/snapshot dataset/);
    }
    expect(() =>
      readSnapshotDataset({ manifest: dataset([record()]).manifest, records: "nope" }),
    ).toThrow(/snapshot dataset/);
  });

  it("refuses an empty dataset (INV-006)", () => {
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      datasetVersion: "v1",
      codeRevision: "abc123",
      createdAt: "2026-11-20T00:00:00.000Z",
      rowCount: 0,
      sha256: snapshotChecksum([]),
    };
    expect(() => readSnapshotDataset({ manifest, records: [] })).toThrow(/at least one record/);
  });
});
