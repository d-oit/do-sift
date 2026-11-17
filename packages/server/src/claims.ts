/**
 * Server-facing claim assessment (issue #160).
 *
 * The structural contract lives in `@do-sift/contracts` so a CLI, exporter, or
 * future UI can reuse it. This module is the answer-surface entry point: it
 * accepts stored answer blocks and the evidence ids that actually exist, and
 * returns a per-claim receipt. It performs no model call and never upgrades
 * "all cited ids exist" into "the evidence entails this claim".
 */
import {
  assessClaims as assessContractClaims,
  summarizeClaims as summarizeContractClaims,
  type ClaimAssessment,
  type ClaimInput,
  type ClaimSupport,
} from "@do-sift/contracts";

export type { ClaimAssessment, ClaimSupport };

export interface SummaryCounts {
  claims: number;
  supported: number;
  partiallySupported: number;
  unresolved: number;
  noCitation: number;
}

export function assessClaims(
  claims: readonly ClaimInput[],
  storedEvidenceIds: ReadonlySet<string>,
): ClaimAssessment[] {
  return assessContractClaims(claims, storedEvidenceIds);
}

export function summarizeClaims(assessments: readonly ClaimAssessment[]): SummaryCounts {
  return summarizeContractClaims(assessments);
}
