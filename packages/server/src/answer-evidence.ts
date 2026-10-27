/** Pure answer-evidence helpers: passage packing, suspect detection, and the evidence-only fallback. */
import {
  estimateTokens,
  suspectEvidenceMarkers,
  type Answer,
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
