/**
 * Pure URL/IP guards for safe-fetch (CORE-06). No I/O here: every function is
 * deterministic and offline-testable. The orchestrator in safe-fetch.ts
 * composes these with an injected DNS resolver and fetch implementation.
 *
 * Hostname checks operate on WHATWG-parsed hostnames (Node's URL parser
 * canonicalizes decimal/hex/octal IPv4 forms like `0x7f000001` to dotted
 * quads), so obfuscated IP literals are caught by parsing first.
 */

/** Categories of safe-fetch refusal, mirrored in SafeFetchError.kind. */
export type SafeFetchFailureKind =
  | "url"
  | "scheme"
  | "userinfo"
  | "private-host"
  | "private-ip"
  | "dns"
  | "redirect"
  | "status"
  | "mime"
  | "size"
  | "timeout"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    public readonly kind: SafeFetchFailureKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "SafeFetchError";
  }
}

/** Parse a dotted-quad IPv4 string into octets, or null if it is not one. */
export function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Expand an IPv6 string (no brackets, lowercase input accepted) into 8
 * 16-bit groups, or null if it is not a valid IPv6 literal.
 */
export function expandIpv6(host: string): readonly number[] | null {
  let s = host.toLowerCase();
  const v4Match = /(\d+\.\d+\.\d+\.\d+)$/u.exec(s);
  if (v4Match?.[1]) {
    const v4 = parseIpv4(v4Match[1]);
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, s.length - v4Match[1].length)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/u.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? "");
  if (!head) return null;
  const tailPart = halves.length === 2 ? (halves[1] ?? "") : null;
  const tail = tailPart === null ? [] : parseGroups(tailPart);
  if (!tail) return null;
  if (tailPart === null) {
    return head.length === 8 ? head : null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isPrivateIpv4Octets(o: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host on this network" (RFC 1122)
  if (a === 10) return true; // 10.0.0.0/8 private (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
  if (a === 127) return true; // 127.0.0.0/8 loopback (RFC 1122)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (RFC 3927)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF Protocol Assignments (RFC 6890)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 Documentation (TEST-NET-1) (RFC 5737)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 Relay Anycast (RFC 3068 / RFC 7526)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking (RFC 2544)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 Documentation (TEST-NET-2) (RFC 5737)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 Documentation (TEST-NET-3) (RFC 5737)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 Multicast (RFC 5771)
  if (a >= 240) return true; // 240.0.0.0/4 Reserved / Limited Broadcast (RFC 1112 / RFC 919)
  return false;
}

export function isPrivateIpv4(host: string): boolean {
  const o = parseIpv4(host);
  return o !== null && isPrivateIpv4Octets(o);
}

export function isPrivateIpv6(host: string): boolean {
  const g = expandIpv6(host);
  if (!g) return false;
  return isPrivateIpv6Groups(g);
}

function isPrivateIpv6Groups(g: readonly number[]): boolean {
  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // unspecified :: (RFC 4291)

  // IPv4-mapped ::ffff:a.b.c.d — inherit the v4 verdict (RFC 4291)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = [(g[6] ?? 0) >> 8, (g[6] ?? 0) & 0xff, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 0xff];
    return isPrivateIpv4Octets(v4);
  }

  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765 / RFC 6052)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
    const v4 = [(g[6] ?? 0) >> 8, (g[6] ?? 0) & 0xff, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 0xff];
    return isPrivateIpv4Octets(v4);
  }

  // Low forms / unspecified / loopback ::1 / IPv4-compatible ::a.b.c.d (deprecated RFC 4291)
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0 &&
    g[6] === 0
  ) {
    return true; // ::/128, ::1/128, ::a.b.c.d
  }

  const g0 = g[0] ?? 0;
  const g1 = g[1] ?? 0;

  if (g0 === 0x0100 && g1 === 0) return true; // 100::/64 Discard-Only Prefix (RFC 6666)
  if (g0 === 0x0064 && (g1 & 0xffc0) === 0x0000) return true; // 64:ff9b::/96 Well-Known Prefix (NAT64 RFC 6052) - may translate to private v4
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // 64:ff9b:1::/48 Local-IPv4/IPv6 Translation (RFC 8215)
  if (g0 === 0x2001 && g1 === 0x0000) return true; // 2001::/32 TEREDO (RFC 4380)
  if (g0 === 0x2001 && g1 === 0x0002 && (g[2] ?? 0) === 0) return true; // 2001:2::/48 Benchmarking (RFC 5180)
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true; // 2001:10::/28 ORCHIDv2 (RFC 7343)
  if (g0 === 0x2001 && (g1 & 0xffe0) === 0x0020) return true; // 2001:20::/28 ORCHID (RFC 4843)
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 Documentation (RFC 3849)
  if (g0 === 0x2002) return true; // 2002::/16 6to4 (RFC 3056)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local (RFC 4291)
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 Deprecated Site-Local (RFC 3879)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local ULA (RFC 4193)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 Multicast (RFC 4291)

  return false;
}

/** Hostnames that can never name a public internet host (conservative). */
function isLocalHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

/**
 * Validate a URL is fetchable at all: http(s) only, no userinfo, and the
 * host is not a local name or a private/reserved IP literal. Returns the
 * parsed URL for the caller. DNS results are validated separately
 * (rebinding guard), as are every redirect hop.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("url", `unparseable URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("scheme", `only http(s) is allowed, got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SafeFetchError("userinfo", "URLs with embedded credentials are not allowed");
  }
  const host = url.hostname.toLowerCase();
  if (isLocalHostname(host)) {
    throw new SafeFetchError("private-host", `local hostname "${host}" is not fetchable`);
  }
  if (host.startsWith("[")) {
    const expanded = expandIpv6(host.slice(1, -1));
    if (!expanded || isPrivateIpv6Groups(expanded)) {
      throw new SafeFetchError("private-ip", `IPv6 literal "${host}" is not a public address`);
    }
  } else if (parseIpv4(host) !== null && isPrivateIpv4(host)) {
    throw new SafeFetchError("private-ip", `IP literal "${host}" is not a public address`);
  }
  return url;
}

/**
 * Validate one resolved DNS address (or bare IP literal). Fails closed on
 * anything unparseable: an address we cannot classify is not fetchable.
 */
export function assertPublicAddress(addr: string): void {
  const a = addr
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (a.includes(":")) {
    const g = expandIpv6(a);
    if (!g || isPrivateIpv6Groups(g)) {
      throw new SafeFetchError("private-ip", `resolved address ${addr} is not public`);
    }
    return;
  }
  const o = parseIpv4(a);
  if (!o || isPrivateIpv4Octets(o)) {
    throw new SafeFetchError("private-ip", `resolved address ${addr} is not public`);
  }
}
