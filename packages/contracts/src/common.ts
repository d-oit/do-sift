import { z } from "zod";

/** Stable identifiers. Owner scoping is mandatory on stored records (ADR 0003). */
export const OwnerId = z.string().min(1).max(128);
export const EvidenceId = z.string().min(1).max(128);

/** http(s) URLs only — enforced again at fetch time by safe-fetch. */
export const HttpUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "only http(s) URLs are permitted in contracts",
  });

/** ISO-8601 timestamps as strings. */
export const Timestamp = z.string().datetime({ offset: true });

/**
 * Publication time must carry its origin. Retrieval time is never displayed
 * as publication time (ADR 0003).
 */
export const PublishedAt = z.object({
  at: Timestamp,
  origin: z.enum(["page-metadata", "provider", "domain-policy", "user"]),
});
