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
  /**
   * Producer-supplied verbatim span (issue #160, plan 070/071). Echoed
   * verbatim into the assessment; validated against `evidenceTexts` when
   * supplied (plan 071), otherwise carried without validation.
   */
  quote?: string | undefined;
  /** The producer already flagged a citation failure. */
  unresolved?: boolean;
  /**
   * Producer honesty flag: cited passages disagree (issue #160, plan 072).
   * System-never-inferred; echoed into the assessment.
   */
  conflicting?: boolean | undefined;
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
  | "upstream-conflict-flag"
  | "malformed-citations"
  | "quote-mismatch";

export interface ClaimAssessment {
  index: number;
  /** Stable claim id: caller-supplied or `claim-<index+1>`. Always non-empty. */
  id: string;
  /** Producer quote echoed verbatim (issue #160, plan 070); absent when none. */
  quote?: string | undefined;
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
 * Normalize a verbatim span for substring comparison (issue #160, plan 071):
 * lowercase, collapse whitespace runs, trim. Case/whitespace differences
 * never fail; semantic paraphrase still fails (quote means verbatim).
 */
export function normalizeQuoteSpan(span: string): string {
  return span.toLowerCase().replace(/\s+/g, " ").trim();
}

function quoteMatchesResolved(
  quote: string,
  resolved: readonly string[],
  evidenceTexts: ReadonlyMap<string, string>,
): boolean {
  const needle = normalizeQuoteSpan(quote);
  if (needle === "") return false;
  return resolved.some((id) => {
    const excerpt = evidenceTexts.get(id);
    if (excerpt === undefined) return false;
    return normalizeQuoteSpan(excerpt).includes(needle);
  });
}

/**
 * Assess each claim against the set of stored evidence ids. Deterministic;
 * no model call and no network.
 *
 * When `evidenceTexts` (passage id → excerpt) is supplied, a present
 * `quote` must appear verbatim (after normalization) in at least one
 * resolved excerpt; otherwise the claim degrades to `partially-supported`
 * with reason `quote-mismatch`. Structural failures (missing/malformed
 * citations) take precedence, so the quote is only checked when every
 * cited id exists and is well-formed. Absent `evidenceTexts` skips
 * validation (plan-070 plumbing behavior).
 */
export function assessClaims(
  claims: readonly ClaimInput[],
  storedEvidenceIds: ReadonlySet<string>,
  evidenceTexts?: ReadonlyMap<string, string> | undefined,
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
    else if (unresolved.length > 0 || claim.unresolved === true || claim.conflicting === true)
      support = "partially-supported";
    else support = "supported";

    let reason: ClaimReason;
    if (citations.length === 0) reason = "no-citations";
    else if (malformed) reason = "malformed-citations";
    else if (resolved.length === 0) reason = "no-citations-resolve";
    else if (unresolved.length > 0) reason = "some-citations-missing";
    else if (
      claim.quote !== undefined &&
      evidenceTexts !== undefined &&
      !quoteMatchesResolved(claim.quote, resolved, evidenceTexts)
    )
      reason = "quote-mismatch";
    else if (claim.conflicting === true) reason = "upstream-conflict-flag";
    else if (claim.unresolved === true) reason = "upstream-unresolved-flag";
    else reason = "all-citations-resolve";
    if (reason === "quote-mismatch" || reason === "upstream-conflict-flag")
      support = "partially-supported";
    const uncertainty: ClaimAssessment["uncertainty"] =
      support === "supported"
        ? "none"
        : support === "partially-supported"
          ? "partial"
          : "unsupported";

    const echoed: ClaimAssessment = {
      index,
      id,
      citations,
      resolved,
      unresolved,
      support,
      uncertainty,
      reason,
    };
    if (claim.quote !== undefined) echoed.quote = claim.quote;
    return echoed;
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
