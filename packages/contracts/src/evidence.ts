import { z } from "zod";
import { EvidenceId, HttpUrl, OwnerId, PublishedAt, Timestamp } from "./common.js";

/**
 * A stored passage of retrieved evidence. Provenance is mandatory: canonical
 * + original URL, document version hash, retrieval time. Stored before any
 * merge or synthesis (ADR 0003).
 */
export const EvidencePassage = z.object({
  id: EvidenceId,
  ownerId: OwnerId,
  canonicalUrl: HttpUrl,
  originalUrl: HttpUrl,
  documentHash: z.string().min(8).max(128),
  retrievedAt: Timestamp,
  publishedAt: PublishedAt.optional(),
  heading: z.string().max(512).optional(),
  excerpt: z.string().min(1).max(8192),
  extractionStatus: z.enum(["ok", "partial", "failed"]),
});
export type EvidencePassage = z.infer<typeof EvidencePassage>;

export const AnswerBlock = z.object({
  kind: z.enum(["paragraph", "list", "caveat"]),
  /** Claim text. Citations reference evidence IDs, validated before display. */
  text: z.string().min(1),
  citations: z.array(EvidenceId),
});
export type AnswerBlock = z.infer<typeof AnswerBlock>;

export const Answer = z.object({
  ownerId: OwnerId,
  question: z.string().min(1).max(512),
  blocks: z.array(AnswerBlock),
  /** Present only in answer mode; search mode answers have zero LLM usage. */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      model: z.string().min(1),
      estimated: z.boolean(),
    })
    .optional(),
  evidenceOnly: z.boolean(),
});
export type Answer = z.infer<typeof Answer>;

export class CitationError extends Error {
  constructor(public readonly unknownIds: string[]) {
    super(`answer references unknown evidence ids: ${unknownIds.join(", ")}`);
    this.name = "CitationError";
  }
}

/**
 * Validate that every citation in the answer refers to evidence actually
 * stored and owned by the requester. Existence is a floor, not entailment
 * (ADR 0003): passing this check never licenses a factual-quality claim.
 */
export function validateCitations(answer: Answer, storedEvidenceIds: ReadonlySet<string>): void {
  const unknown = new Set<string>();
  for (const block of answer.blocks) {
    for (const id of block.citations) {
      if (!storedEvidenceIds.has(id)) unknown.add(id);
    }
  }
  if (unknown.size > 0) throw new CitationError([...unknown]);
}
