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
  /**
   * Stable caller-supplied claim id (plan 068, issue #160). Blank or
   * absent generates `claim-<index+1>` in the assessment. Duplicate
   * caller ids are echoed verbatim; uniqueness is the producer's contract.
   */
  id?: string;
}

export type ClaimSupport = "supported" | "partially-supported" | "unresolved" | "no-citation";

export type ClaimReason =
  | "all-citations-resolve"
  | "some-citations-missing"
  | "no-citations-resolve"
  | "no-citations"
  | "upstream-unresolved-flag"
  | "malformed-citations";

export interface ClaimAssessment {
  index: number;
  /** Stable claim id: caller-supplied or `claim-<index+1>`. Always non-empty. */
  id: string;
  /** Unique citation ids in first-seen order. */
  citations: string[];
  resolved: string[];
  unresolved: string[];
  support: ClaimSupport;
  /** Display hint; `none` never means "verified true". */
  uncertainty: "none" | "partial" | "unsupported";
  /** Machine-readable reason for the support value. */
  reason: ClaimReason;
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
    const id =
      typeof claim.id === "string" && claim.id.trim() !== "" ? claim.id : `claim-${index + 1}`;
    const citations: string[] = [];
    const resolved: string[] = [];
    const unresolved: string[] = [];
    let malformed = false;
    for (const raw of claim.citations) {
      // Malformed ids (non-string, empty/whitespace) are never resolved:
      // they degrade the claim honestly instead of matching stored evidence.
      if (typeof raw !== "string" || raw.trim() === "") malformed = true;
      if (citations.includes(raw)) continue;
      citations.push(raw);
      if (typeof raw === "string" && raw.trim() !== "" && storedEvidenceIds.has(raw))
        resolved.push(raw);
      else unresolved.push(raw);
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

    let reason: ClaimReason;
    if (citations.length === 0) reason = "no-citations";
    else if (malformed) reason = "malformed-citations";
    else if (resolved.length === 0) reason = "no-citations-resolve";
    else if (unresolved.length > 0) reason = "some-citations-missing";
    else if (claim.unresolved === true) reason = "upstream-unresolved-flag";
    else reason = "all-citations-resolve";

    return { index, id, citations, resolved, unresolved, support, uncertainty, reason };
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
