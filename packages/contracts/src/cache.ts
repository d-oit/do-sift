import { z } from "zod";
import { OwnerId } from "./common.js";

/**
 * Deterministic cache-key inputs. Exact-answer caching only (D5/Plan 004):
 * the key must preserve negation, quantities, versions, and temporal
 * meaning; a different owner never shares a cache entry.
 */
export const CacheKeyInput = z.object({
  ownerId: OwnerId,
  question: z.string().min(1).max(512),
  mode: z.enum(["search", "answer"]),
  language: z.string().min(2).max(8).default("en"),
  sourceVersions: z.array(z.string().min(8).max(128)).default([]),
  policyRevision: z.string().min(1),
  promptRevision: z.string().min(1),
  modelRevision: z.string().min(1),
});
export type CacheKeyInput = z.infer<typeof CacheKeyInput>;

/**
 * Normalize a question for exact-cache lookups: collapse whitespace, trim,
 * NFC-normalize, lowercase. Deliberately conservative — we never stem or
 * drop words, because "does not support" must never hit "does support".
 */
export function normalizeQuestion(question: string): string {
  return question.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** FNV-1a 64-bit as hex — stable across processes, no dependencies. */
function fnv1a64(input: string): string {
  // BigInt FNV-1a with prime 0x100000001b3, offset 0xcbf29ce484222325.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildCacheKey(input: CacheKeyInput): string {
  const canonical = JSON.stringify({
    o: input.ownerId,
    q: normalizeQuestion(input.question),
    m: input.mode,
    l: input.language,
    s: [...input.sourceVersions].sort(),
    p: input.policyRevision,
    pr: input.promptRevision,
    mr: input.modelRevision,
  });
  return `ans:v1:${fnv1a64(canonical)}`;
}
