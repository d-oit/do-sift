/**
 * Reproducible source-quality report (issue #157, plan 065).
 *
 * Read-only and deterministic: the same document/passage rows plus the
 * same provenance produce the same report. There is no wall-clock
 * timestamp and no imputation — missing or non-conforming dates fall in
 * the `unknown` bucket and are counted, and domain concentration is
 * counts plus shares, never a reliability score. Empty input yields
 * zeros and empty buckets.
 *
 * Publication age uses calendar `YYYY-MM` buckets of `publishedAt`, so
 * the report is stable without a reference "now". Duplicates are exact
 * `contentHash` groups with more than one document ("where measured" —
 * near-duplicate similarity is out of scope). A NULL `noiseClass`
 * (legacy/unclassified passages) is its own `unclassified` bucket: a
 * stored state, not a guess.
 */
import type { ReportProvenance } from "./report.js";

export interface SourceDocumentRow {
  url: string;
  /** Caller-derived host; unknown when absent. */
  domain?: string | undefined;
  /** ISO-8601 publication time; unknown when absent or non-conforming. */
  publishedAt?: string | undefined;
  contentHash: string;
}

export interface SourcePassageRow {
  extractionStatus: string;
  /** Stored noise class; NULL/legacy rows are `unclassified`. */
  noiseClass?: string | undefined;
}

export interface DomainBucket {
  domain: string;
  count: number;
}

export interface YearMonthBucket {
  yearMonth: string;
  count: number;
}

export interface StatusBucket {
  status: string;
  count: number;
}

export interface NoiseBucket {
  class: string;
  count: number;
}

export interface SourceQualityReport {
  provenance: ReportProvenance;
  documentCount: number;
  withPublishedDate: number;
  unknownDateCount: number;
  unknownDateShare: number;
  /** Calendar buckets of conforming `publishedAt`, ascending. */
  publishedYearMonth: YearMonthBucket[];
  /** Non-conforming or missing dates, counted but not bucketed by month. */
  unknownDateBucket: number;
  /** Descriptive concentration, count desc with name-asc ties. */
  domains: Array<DomainBucket & { share: number }>;
  duplicateGroups: number;
  duplicateDocuments: number;
  duplicateShare: number;
  extractionStatuses: Array<StatusBucket & { share: number }>;
  noiseClasses: Array<NoiseBucket & { share: number }>;
}

export const SOURCE_QUALITY_REPORT_VERSION = "source-quality/v1";

const YEAR_MONTH = /^(\d{4}-\d{2})/u;

function assertDocument(row: SourceDocumentRow): void {
  if (row.url.trim() === "") throw new Error("source-quality document url must not be empty");
  if (row.contentHash.trim() === "") {
    throw new Error(`source-quality document ${row.url}: contentHash must not be empty`);
  }
}

function assertPassage(row: SourcePassageRow): void {
  if (row.extractionStatus.trim() === "") {
    throw new Error("source-quality passage extractionStatus must not be empty");
  }
}

function orderBuckets<B>(
  entries: Array<[string, number]>,
  make: (key: string, count: number) => B,
): B[] {
  return entries
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, count]) => make(key, count));
}

function withShares<T extends { count: number }>(
  buckets: T[],
  total: number,
): Array<T & { share: number }> {
  return buckets.map((bucket) => ({
    ...bucket,
    share: total === 0 ? 0 : bucket.count / total,
  }));
}

export async function buildSourceQualityReport(
  documents: readonly SourceDocumentRow[],
  passages: readonly SourcePassageRow[],
  provenance: ReportProvenance,
): Promise<SourceQualityReport> {
  for (const row of documents) assertDocument(row);
  for (const row of passages) assertPassage(row);

  const months = new Map<string, number>();
  const domains = new Map<string, number>();
  const hashes = new Map<string, number>();
  let withDate = 0;
  let unknownDate = 0;
  for (const doc of documents) {
    const match = doc.publishedAt === undefined ? null : YEAR_MONTH.exec(doc.publishedAt);
    if (match === null) {
      unknownDate++;
    } else {
      withDate++;
      months.set(match[1] ?? "", (months.get(match[1] ?? "") ?? 0) + 1);
    }
    const domain = doc.domain === undefined || doc.domain.trim() === "" ? "unknown" : doc.domain;
    domains.set(domain, (domains.get(domain) ?? 0) + 1);
    hashes.set(doc.contentHash, (hashes.get(doc.contentHash) ?? 0) + 1);
  }

  const statuses = new Map<string, number>();
  const noise = new Map<string, number>();
  for (const passage of passages) {
    statuses.set(passage.extractionStatus, (statuses.get(passage.extractionStatus) ?? 0) + 1);
    const cls =
      passage.noiseClass === undefined || passage.noiseClass.trim() === ""
        ? "unclassified"
        : passage.noiseClass;
    noise.set(cls, (noise.get(cls) ?? 0) + 1);
  }

  let duplicateGroups = 0;
  let duplicateDocuments = 0;
  for (const count of hashes.values()) {
    if (count > 1) {
      duplicateGroups++;
      duplicateDocuments += count;
    }
  }

  const documentCount = documents.length;
  return {
    provenance: { ...provenance },
    documentCount,
    withPublishedDate: withDate,
    unknownDateCount: unknownDate,
    unknownDateShare: documentCount === 0 ? 0 : unknownDate / documentCount,
    publishedYearMonth: [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([yearMonth, count]) => ({ yearMonth, count })),
    unknownDateBucket: unknownDate,
    domains: withShares(
      orderBuckets<DomainBucket>([...domains.entries()], (domain, count) => ({
        domain,
        count,
      })),
      documentCount,
    ),
    duplicateGroups,
    duplicateDocuments,
    duplicateShare: documentCount === 0 ? 0 : duplicateDocuments / documentCount,
    extractionStatuses: withShares(
      orderBuckets<StatusBucket>([...statuses.entries()], (status, count) => ({
        status,
        count,
      })),
      passages.length,
    ),
    noiseClasses: withShares(
      orderBuckets<NoiseBucket>([...noise.entries()], (cls, count) => ({
        class: cls,
        count,
      })),
      passages.length,
    ),
  };
}
