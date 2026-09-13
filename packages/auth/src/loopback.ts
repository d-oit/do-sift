/**
 * Loopback classification for the dev-auth bypass (CORE-04). IP-strict by
 * design: "localhost" and other names are refused — only literal loopback
 * addresses count, so the bypass can never survive a DNS trick. IP parsing
 * reuses the safe-fetch guards (single classification source).
 */
import { expandIpv6, parseIpv4 } from "@do-sift/safe-fetch";

/**
 * Reduce a client-address string to a bare host: strips `[v6]:port`
 * bracket form and `host:port` when unambiguous (exactly one colon).
 * Multi-colon strings are IPv6 literals and pass through unchanged.
 */
export function parseClientHost(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? "" : trimmed.slice(1, end);
  }
  const colonCount = (trimmed.match(/:/gu) ?? []).length;
  if (colonCount === 1) return trimmed.slice(0, trimmed.indexOf(":"));
  return trimmed;
}

/**
 * True only for literal loopback addresses: 127.0.0.0/8, ::1, and
 * IPv4-mapped ::ffff:127.x.x.x, with optional port or bracket forms.
 * Everything else — public IPs, private LAN IPs, names, garbage — is false
 * (fail closed).
 */
export function isLoopbackAddress(address: string): boolean {
  const host = parseClientHost(address).toLowerCase();
  if (host.length === 0) return false;

  const v4 = parseIpv4(host);
  if (v4) return (v4[0] ?? 0) === 127;

  const groups = expandIpv6(host);
  if (!groups) return false;
  // ::1 — unspecified prefix with a 1 in the last group
  if (groups.slice(0, 7).every((g) => g === 0) && (groups[7] ?? 0) === 1) return true;
  // ::ffff:127.x.x.x — IPv4-mapped loopback (0xffff in group 5, first v4 octet high byte of group 6)
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return (groups[6] ?? 0) >> 8 === 127;
  }
  return false;
}
