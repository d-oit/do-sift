/** Pure answer-evidence helpers: passage packing, suspect detection, and the evidence-only fallback. */
import {
  estimateTokens,
  suspectEvidenceMarkers,
  type Answer,
  type AnswerBlock,
  type EvidenceMarker,
} from "@do-sift/contracts";
import type { SuspectReceipt } from "./answer-contracts.js";
export function packPassages(
  question: string,
  passages: Array<{ id: string; text: string }>,
  maxInputTokens: number,
  maxOutputTokens: number,
): Array<{ id: string; text: string }> {
  const packed = [...passages];
  while (
    packed.length > 1 &&
    estimateTokens([question, ...packed.map((p) => p.text)].join(" ")) + maxOutputTokens >
      maxInputTokens
  ) {
    packed.pop();
  }
  return packed;
}
export function detectSuspects(packed: Array<{ id: string; text: string }>): SuspectReceipt {
  const markers = new Set<EvidenceMarker>();
  let passages = 0;
  for (const p of packed) {
    const found = suspectEvidenceMarkers(p.text);
    if (found.length > 0) {
      passages += 1;
      for (const m of found) markers.add(m);
    }
  }
  return { passages, markers: [...markers].sort() };
}
/**
 * Per-claim citation validation (issue #127): keep every claim, strip the
 * citations that do not resolve, and flag that claim `unresolved` so the UI
 * cannot present it as grounded. Claims with no citations are unresolved by
 * definition. Returns the surviving-claim count so the caller can fall back
 * to a wholly evidence-only answer when nothing survived.
 */
export function markUnresolvedClaims(
  answer: Answer,
  storedEvidenceIds: ReadonlySet<string>,
): { blocks: AnswerBlock[]; unresolved: number; resolvedClaims: number } {
  let unresolved = 0;
  let resolvedClaims = 0;
  const blocks = answer.blocks.map((block): AnswerBlock => {
    const known = block.citations.filter((id) => storedEvidenceIds.has(id));
    if (known.length > 0 && known.length === block.citations.length) {
      resolvedClaims += 1;
      return block;
    }
    unresolved += 1;
    return { ...block, citations: known, unresolved: true };
  });
  return { blocks, unresolved, resolvedClaims };
}
export function evidenceOnlyAnswer(
  ownerId: string,
  question: string,
  passages: Array<{ id: string; text: string }>,
): Answer {
  return {
    ownerId,
    question,
    blocks: passages.map((p) => ({
      kind: "paragraph" as const,
      text: p.text,
      citations: [p.id], // self-citation: the passage itself is the receipt
    })),
    evidenceOnly: true,
  };
}
