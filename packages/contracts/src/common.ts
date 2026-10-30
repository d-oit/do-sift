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

/** Maintainer contact channel for upstream API operators (Wikimedia UA policy & R-13). */
export const CONTACT_URL = "https://github.com/d-oit/do-sift";

/** Default product version when no override is passed. */
export const DEFAULT_VERSION = "0.1.0";

/**
 * Builds a policy-compliant User-Agent header value for upstream provider requests.
 * Format: `do-sift/<version> (research-with-receipts engine; +<contactUrl>)`
 */
export function buildUserAgent(
  version: string = DEFAULT_VERSION,
  contactUrl: string = CONTACT_URL,
): string {
  const cleanVersion = version.trim() || DEFAULT_VERSION;
  const cleanContact = contactUrl.trim() || CONTACT_URL;
  return `do-sift/${cleanVersion} (research-with-receipts engine; +${cleanContact})`;
}

/** Canonical descriptive, contactable User-Agent header string. */
export const USER_AGENT = buildUserAgent();
