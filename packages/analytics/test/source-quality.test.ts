/** Source-quality report (issue #157, plan 065, SQ-02): deterministic buckets, explicit unknowns, exact-hash duplicates. */
import { describe, expect, it } from "vitest";
import {
  buildSourceQualityReport,
  type SourceDocumentRow,
  type SourcePassageRow,
} from "../src/source-quality.js";

const PROVENANCE = {
  datasetVersion: "evals/v12",
  baselineVersion: "ret-baseline/v2",
  codeRevision: "deadbeef",
  reportVersion: "source-quality/v1",
};

const DOCUMENTS: SourceDocumentRow[] = [
  {
    url: "https://a.test/page",
    domain: "a.test",
    publishedAt: "2026-03-10T00:00:00Z",
    contentHash: "hash-1",
  },
  {
    url: "https://b.test/page",
    domain: "b.test",
    publishedAt: "2026-03-22T00:00:00Z",
    contentHash: "hash-2",
  },
  {
    url: "https://a.test/other",
    domain: "a.test",
    contentHash: "hash-1",
  },
  { url: "https://c.test/page", contentHash: "hash-3", publishedAt: "not-a-date" },
];

const PASSAGES: SourcePassageRow[] = [
  { extractionStatus: "ok", noiseClass: "clean" },
  { extractionStatus: "ok", noiseClass: "clean" },
  { extractionStatus: "partial" },
  { extractionStatus: "ok", noiseClass: "boilerplate" },
];

describe("buildSourceQualityReport", () => {
  it("echoes provenance and orders buckets deterministically with shares", async () => {
    const report = await buildSourceQualityReport(DOCUMENTS, PASSAGES, PROVENANCE);
    expect(report.provenance).toEqual(PROVENANCE);
    expect(report.documentCount).toBe(4);
    expect(report.withPublishedDate).toBe(2);
    expect(report.unknownDateCount).toBe(2);
    expect(report.unknownDateShare).toBeCloseTo(0.5);
    expect(report.publishedYearMonth).toEqual([{ yearMonth: "2026-03", count: 2 }]);
    expect(report.unknownDateBucket).toBe(2);
    expect(report.domains).toEqual([
      { domain: "a.test", count: 2, share: 0.5 },
      { domain: "b.test", count: 1, share: 0.25 },
      { domain: "unknown", count: 1, share: 0.25 },
    ]);
  });

  it("reports exact-hash duplicates and passage distributions with an unclassified bucket", async () => {
    const report = await buildSourceQualityReport(DOCUMENTS, PASSAGES, PROVENANCE);
    expect(report.duplicateGroups).toBe(1);
    expect(report.duplicateDocuments).toBe(2);
    expect(report.duplicateShare).toBeCloseTo(0.5);
    expect(report.extractionStatuses).toEqual([
      { status: "ok", count: 3, share: 0.75 },
      { status: "partial", count: 1, share: 0.25 },
    ]);
    expect(report.noiseClasses).toEqual([
      { class: "clean", count: 2, share: 0.5 },
      { class: "boilerplate", count: 1, share: 0.25 },
      { class: "unclassified", count: 1, share: 0.25 },
    ]);
  });

  it("yields empty buckets for empty input", async () => {
    const report = await buildSourceQualityReport([], [], PROVENANCE);
    expect(report.documentCount).toBe(0);
    expect(report.domains).toEqual([]);
    expect(report.publishedYearMonth).toEqual([]);
    expect(report.extractionStatuses).toEqual([]);
    expect(report.noiseClasses).toEqual([]);
    expect(report.duplicateGroups).toBe(0);
    expect(report.unknownDateShare).toBe(0);
  });

  it("rejects malformed rows instead of imputing them", async () => {
    await expect(
      buildSourceQualityReport([{ url: "", contentHash: "h" }], [], PROVENANCE),
    ).rejects.toThrow();
    await expect(
      buildSourceQualityReport([{ url: "https://a.test/x", contentHash: "" }], [], PROVENANCE),
    ).rejects.toThrow();
    await expect(
      buildSourceQualityReport([], [{ extractionStatus: "" }], PROVENANCE),
    ).rejects.toThrow();
  });

  it("is deterministic for identical inputs", async () => {
    const first = await buildSourceQualityReport(DOCUMENTS, PASSAGES, PROVENANCE);
    const second = await buildSourceQualityReport(DOCUMENTS, PASSAGES, PROVENANCE);
    expect(second).toEqual(first);
  });

  it("sorts domain ties by name ascending", async () => {
    const report = await buildSourceQualityReport(
      [
        { url: "https://z.test/1", domain: "z.test", contentHash: "h1" },
        { url: "https://a.test/1", domain: "a.test", contentHash: "h2" },
      ],
      [],
      PROVENANCE,
    );
    expect(report.domains.map((d) => d.domain)).toEqual(["a.test", "z.test"]);
  });
});
