/**
 * Claim-to-evidence assessment (issue #160).
 *
 * This is a **structural** assessment: it reports whether cited evidence ids
 * exist, not whether the evidence entails the claim. Existence is a floor,
 * never a truth verdict (ADR 0003/0004). An unresolved claim is surfaced, not
 * repaired or silently dropped.
 */
export interface ClaimInput {
  kind: "paragraph" | "list" | "caveat";
  text: string;
  citations: readonly string[];
  /** The producer already flagged a citation failure. */
  unresolved?: boolean;
}

export type ClaimSupport = "supported" | "partially-supported" | "unresolved" | "no-citation";

export interface ClaimAssessment {
  index: number;
  /** Unique citation ids in first-seen order. */
  citations: string[];
  resolved: string[];
  unresolved: string[];
  support: ClaimSupport;
  /** Display hint; `none` never means "verified true". */
  uncertainty: "none" | "partial" | "unsupported";
}

/**
 * Assess each claim against the set of stored evidence ids. Deterministic;
 * no model call and no network.
 */
export function assessClaims(
  claims: readonly ClaimInput[],
  storedEvidenceIds: ReadonlySet<string>,
): ClaimAssessment[] {
  return claims.map((claim, index) => {
    const citations: string[] = [];
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const id of claim.citations) {
      if (citations.includes(id)) continue;
      citations.push(id);
      if (storedEvidenceIds.has(id)) resolved.push(id);
      else unresolved.push(id);
    }
    let support: ClaimSupport;
    if (citations.length === 0) support = "no-citation";
    else if (resolved.length === 0) support = "unresolved";
    else if (unresolved.length > 0 || claim.unresolved === true) support = "partially-supported";
    else support = "supported";

    const uncertainty: ClaimAssessment["uncertainty"] =
      support === "supported"
        ? "none"
        : support === "partially-supported"
          ? "partial"
          : "unsupported";

    return { index, citations, resolved, unresolved, support, uncertainty };
  });
}

/** Aggregate counts for a receipt; unknown is never rounded up to supported. */
export function summarizeClaims(assessments: readonly ClaimAssessment[]): {
  claims: number;
  supported: number;
  partiallySupported: number;
  unresolved: number;
  noCitation: number;
} {
  return {
    claims: assessments.length,
    supported: assessments.filter((a) => a.support === "supported").length,
    partiallySupported: assessments.filter((a) => a.support === "partially-supported").length,
    unresolved: assessments.filter((a) => a.support === "unresolved").length,
    noCitation: assessments.filter((a) => a.support === "no-citation").length,
  };
}
