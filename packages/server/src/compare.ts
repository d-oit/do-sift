/**
 * Side-by-side evidence comparison (issue #169).
 *
 * A deterministic view over **already stored** evidence. It never fetches,
 * never calls a model, and never ranks sources as more or less trustworthy:
 * agreement and difference are relationships between excerpts, not a truth
 * verdict. Missing metadata stays missing (renderers must show `unknown`).
 *
 * The caller supplies rows it is already authorized to read; this module
 * performs no storage access, so it cannot widen a tenant/owner scope.
 */
export const COMPARISON_SCHEMA_VERSION = 1;
export const COMPARISON_MIN_SOURCES = 2;
export const COMPARISON_MAX_SOURCES = 8;

export interface ComparisonSourceInput {
  /** Stored evidence id. */
  evidenceId: string;
  url: string;
  title?: string | undefined;
  publisher?: string | undefined;
  /** Publication time from the source metadata, when known. */
  publishedAt?: string | undefined;
  /** When do-sift retrieved the source — never displayed as publication time. */
  retrievedAt: string;
  contentHash?: string | undefined;
  heading?: string | undefined;
  excerpt: string;
  /** Claim ids this passage was mapped to, when a claim contract provides them. */
  claimIds?: string[] | undefined;
}

export interface ComparisonCell {
  evidenceId: string;
  url: string;
  title?: string | undefined;
  publisher?: string | undefined;
  publishedAt?: string | undefined;
  retrievedAt: string;
  contentHash?: string | undefined;
  heading?: string | undefined;
  excerpt: string;
  claimIds: string[];
}

export type ComparisonObservationKind =
  | "same-excerpt"
  | "different-excerpt"
  | "same-content-hash"
  | "different-content-hash"
  | "publication-date-mismatch"
  | "missing-publication-date";

export interface ComparisonObservation {
  kind: ComparisonObservationKind;
  evidenceIds: string[];
  /** Human-readable note; descriptive, never a reliability verdict. */
  note: string;
}

export interface EvidenceComparison {
  schemaVersion: number;
  sources: ComparisonCell[];
  observations: ComparisonObservation[];
  notice: string;
}

export class ComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComparisonError";
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Build a comparison for two or more distinct stored sources. Order follows
 * the caller's selection so a UI can present a stable side-by-side layout.
 */
export function compareEvidence(
  input: readonly ComparisonSourceInput[],
  selectedIds?: readonly string[],
): EvidenceComparison {
  const selected =
    selectedIds === undefined
      ? [...input]
      : selectedIds.map((id) => {
          const found = input.find((source) => source.evidenceId === id);
          if (found === undefined) throw new ComparisonError(`unknown evidence id "${id}"`);
          return found;
        });

  if (selected.length < COMPARISON_MIN_SOURCES) {
    throw new ComparisonError(`select at least ${COMPARISON_MIN_SOURCES} sources to compare`);
  }
  if (selected.length > COMPARISON_MAX_SOURCES) {
    throw new ComparisonError(`at most ${COMPARISON_MAX_SOURCES} sources can be compared`);
  }
  const seen = new Set<string>();
  for (const source of selected) {
    if (source.evidenceId.trim() === "")
      throw new ComparisonError("source has an empty evidence id");
    if (seen.has(source.evidenceId)) {
      throw new ComparisonError(`duplicate evidence id "${source.evidenceId}"`);
    }
    seen.add(source.evidenceId);
  }

  const sources: ComparisonCell[] = selected.map((source) => ({
    evidenceId: source.evidenceId,
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.publisher === undefined ? {} : { publisher: source.publisher }),
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
    retrievedAt: source.retrievedAt,
    ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }),
    ...(source.heading === undefined ? {} : { heading: source.heading }),
    excerpt: source.excerpt,
    claimIds: [...(source.claimIds ?? [])].sort(),
  }));

  const observations: ComparisonObservation[] = [];
  const ids = sources.map((s) => s.evidenceId);

  const normalized = new Set(sources.map((s) => normalizeText(s.excerpt)));
  observations.push(
    normalized.size === 1
      ? {
          kind: "same-excerpt",
          evidenceIds: ids,
          note: "The selected excerpts are textually equivalent.",
        }
      : {
          kind: "different-excerpt",
          evidenceIds: ids,
          note: "The selected excerpts differ; this is an observed difference, not a truth verdict.",
        },
  );

  const hashes = new Set(
    sources.map((s) => s.contentHash).filter((h): h is string => h !== undefined),
  );
  if (hashes.size === 1 && sources.every((s) => s.contentHash !== undefined)) {
    observations.push({
      kind: "same-content-hash",
      evidenceIds: ids,
      note: "All selected sources carry the same stored content hash.",
    });
  } else if (hashes.size > 1) {
    observations.push({
      kind: "different-content-hash",
      evidenceIds: ids,
      note: "The selected sources carry different content hashes.",
    });
  }

  const published = sources.map((s) => s.publishedAt).filter((p): p is string => p !== undefined);
  if (published.length === 0) {
    observations.push({
      kind: "missing-publication-date",
      evidenceIds: ids,
      note: "No publication date is known; retrieval time is not a substitute.",
    });
  } else if (published.length < sources.length) {
    observations.push({
      kind: "missing-publication-date",
      evidenceIds: sources.filter((s) => s.publishedAt === undefined).map((s) => s.evidenceId),
      note: "Some selected sources have no known publication date.",
    });
  } else if (new Set(published.map((p) => p.slice(0, 10))).size > 1) {
    observations.push({
      kind: "publication-date-mismatch",
      evidenceIds: ids,
      note: "The selected sources carry different publication dates.",
    });
  }

  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    sources,
    observations,
    notice:
      "Differences are relationships between stored excerpts. Recency, popularity, and domain are not reliability or truth signals.",
  };
}
