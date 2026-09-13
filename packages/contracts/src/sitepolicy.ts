import { z } from "zod";

/**
 * Shipped site-access default-deny registry (ADR 0005, INV-007). Sites whose
 * terms prohibit automated access are denied for browser/computer harnesses
 * by default. Extending this list is a policy change; *shrinking* it requires
 * a new ADR and recorded authorization for the specific site.
 */
export const DEFAULT_DENY_SITES: readonly string[] = Object.freeze(["linkedin.com"] as const);

export const DenyCheck = z.object({
  host: z.string().min(1).max(253),
});

/**
 * Canonical host form for policy comparisons: trimmed, lowercased, `www.`
 * prefix and trailing dot stripped, port removed (both `host:port` and
 * bracketed `[v6]:port`). Unparseable/empty input normalizes to "" so
 * callers can fail closed.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end !== -1) h = h.slice(1, end);
  } else {
    // strip a port only when unambiguous (a single colon; multi-colon = bare IPv6)
    const colons = (h.match(/:/gu) ?? []).length;
    if (colons === 1) h = h.slice(0, h.indexOf(":"));
  }
  h = h.replace(/^www\./u, "").replace(/\.$/u, "");
  return h;
}

function matchesEntry(normalizedHost: string, entry: string): boolean {
  const e = normalizeHost(entry);
  return e.length > 0 && (normalizedHost === e || normalizedHost.endsWith(`.${e}`));
}

/** True when the host (or its registrable parent) matches the deny list. */
export function isSiteDenied(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) return false;
  return DEFAULT_DENY_SITES.some((site) => matchesEntry(normalized, site));
}
