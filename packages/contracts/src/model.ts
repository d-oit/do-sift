import { z } from "zod";
import { EvidenceId } from "./common.js";

/**
 * Normalized model usage report. `estimated` marks tokenizer-derived counts;
 * provider-reported usage reconciles later (Plan 004).
 */
export const ModelUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  model: z.string().min(1),
  estimated: z.boolean(),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

export const SynthesisRequest = z.object({
  question: z.string().min(1).max(512),
  /** Evidence passages selected by retrieval; the model gets nothing else. */
  passages: z.array(
    z.object({
      id: EvidenceId,
      text: z.string().max(8192),
    }),
  ),
  /** Bounded recent follow-up context; never a full thread replay (ADR 0006). */
  followUps: z.array(z.string().max(512)).max(3).default([]),
  maxInputTokens: z.number().int().min(1).max(32_000),
  maxOutputTokens: z.number().int().min(1).max(4_000),
});
export type SynthesisRequest = z.infer<typeof SynthesisRequest>;

export const DraftAnswer = z.object({
  blocks: z.array(
    z.object({
      kind: z.enum(["paragraph", "list", "caveat"]),
      text: z.string().min(1),
      citations: z.array(EvidenceId),
    }),
  ),
  usage: ModelUsage,
});
export type DraftAnswer = z.infer<typeof DraftAnswer>;

/**
 * Model adapter. Implementations must be single-call: no tool loops, no
 * retries after a billable attempt, no autonomous fallback (ADR 0006).
 */
export interface ModelProvider {
  readonly name: string;
  readonly modelId: string;
  complete(request: SynthesisRequest, signal?: AbortSignal): Promise<DraftAnswer>;
}

export function estimateTokens(text: string): number {
  // Conservative whitespace+split heuristic; replaced by a provider-compatible
  // tokenizer when one is wired. Always an over-estimate for ASCII prose.
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3);
}
