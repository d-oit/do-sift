import { describe, expect, it } from "vitest";
import {
  SafeFetchError,
  assertPublicAddress,
  assertPublicHttpUrl,
  expandIpv6,
  isPrivateIpv4,
  isPrivateIpv6,
  safeFetch,
  type DnsResolver,
  type FetchLike,
  type SafeFetchOptions,
} from "../src/index.js";

// TEST-NET documentation addresses (RFC 5737) stand in for "public" IPs;
// they are not in the private/reserved guard ranges.
const PUBLIC_V4 = "203.0.113.10";
const PUBLIC_V6 = "2001:db8::10";

function makeDns(addrs: string[]): DnsResolver {
  return { lookup: async () => addrs };
}

function makeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchLike {
  return async (url, init) => handler(url, init);
}

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function makeOptions(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
    maxRedirects: 3,
    dns: makeDns([PUBLIC_V4]),
    fetchImpl: makeFetch(() => htmlResponse("<p>ok</p>")),
    ...overrides,
  };
}

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SafeFetchError) return e.kind;
    throw e;
  }
  throw new Error("expected SafeFetchError");
}

async function kindOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SafeFetchError) return e.kind;
    throw e;
  }
  throw new Error("expected SafeFetchError");
}

describe("URL guards", () => {
  it("rejects non-http schemes", () => {
    expect(kindOf(() => assertPublicHttpUrl("file:///etc/passwd"))).toBe("scheme");
    expect(kindOf(() => assertPublicHttpUrl("data:text/html,hi"))).toBe("scheme");
    expect(kindOf(() => assertPublicHttpUrl("javascript:alert(1)"))).toBe("scheme");
    expect(kindOf(() => assertPublicHttpUrl("ftp://example.org/x"))).toBe("scheme");
  });

  it("rejects embedded credentials", () => {
    expect(kindOf(() => assertPublicHttpUrl("http://user:pass@example.org/"))).toBe("userinfo");
  });

  it("rejects private IPv4 literals", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.10.10",
      "0.0.0.0",
      "100.64.1.1",
      "198.18.0.5",
      "224.0.0.1",
    ]) {
      expect(kindOf(() => assertPublicHttpUrl(`http://${host}/`))).toBe("private-ip");
    }
  });

  it("rejects obfuscated IPv4 forms via WHATWG canonicalization", () => {
    // 2130706433 = 127.0.0.1; Node's URL parser normalizes it before we look.
    expect(kindOf(() => assertPublicHttpUrl("http://2130706433/"))).toBe("private-ip");
    expect(kindOf(() => assertPublicHttpUrl("http://0x7f000001/"))).toBe("private-ip");
  });

  it("rejects private IPv6 literals", () => {
    for (const host of ["[::1]", "[fe80::1]", "[fc00::1]", "[::ffff:10.0.0.1]", "[::]"]) {
      expect(kindOf(() => assertPublicHttpUrl(`http://${host}/`))).toBe("private-ip");
    }
  });

  it("rejects local hostnames", () => {
    for (const host of ["localhost", "sub.localhost", "box.local", "svc.internal"]) {
      expect(kindOf(() => assertPublicHttpUrl(`http://${host}/`))).toBe("private-host");
    }
  });

  it("accepts public URLs", () => {
    expect(assertPublicHttpUrl("https://example.org/a?b=c").host).toBe("example.org");
    expect(assertPublicHttpUrl(`http://${PUBLIC_V4}/`).hostname).toBe(PUBLIC_V4);
    expect(assertPublicHttpUrl(`http://[${PUBLIC_V6}]/`).hostname).toBe(`[${PUBLIC_V6}]`);
  });
});

describe("IP classification", () => {
  it("classifies IPv4", () => {
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("192.168.0.1")).toBe(true);
    expect(isPrivateIpv4("172.15.255.255")).toBe(false);
    expect(isPrivateIpv4("172.32.0.0")).toBe(false);
    expect(isPrivateIpv4(PUBLIC_V4)).toBe(false);
  });

  it("classifies IPv6 including mapped IPv4", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
    expect(isPrivateIpv6("::")).toBe(true);
    expect(isPrivateIpv6("fe80::1")).toBe(true);
    expect(isPrivateIpv6("fd00::1")).toBe(true);
    expect(isPrivateIpv6("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIpv6("::ffff:203.0.113.5")).toBe(false);
    expect(isPrivateIpv6("2001:db8::1")).toBe(false);
  });

  it("expands compressed forms", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6("::::")).toBeNull();
    expect(expandIpv6("gg00::1")).toBeNull();
  });

  it("fails closed on unparseable resolved addresses", () => {
    expect(() => assertPublicAddress("not-an-ip")).toThrow(SafeFetchError);
    expect(() => assertPublicAddress(":::")).toThrow(SafeFetchError);
  });
});

describe("DNS rebinding guard", () => {
  it("rejects when any resolved address is private (fail closed)", async () => {
    const p = safeFetch("https://rebind.test/", makeOptions({ dns: makeDns(["10.0.0.9"]) }));
    await expect(kindOfAsync(p)).resolves.toBe("private-ip");

    const mixed = safeFetch(
      "https://rebind.test/",
      makeOptions({ dns: makeDns([PUBLIC_V4, "10.0.0.9"]) }),
    );
    await expect(kindOfAsync(mixed)).resolves.toBe("private-ip");
  });

  it("rejects empty DNS answers", async () => {
    const p = safeFetch("https://empty.test/", makeOptions({ dns: makeDns([]) }));
    await expect(kindOfAsync(p)).resolves.toBe("dns");
  });

  it("validates addresses on every redirect hop (re-resolve)", async () => {
    const dns = makeDns([PUBLIC_V4]);
    let calls = 0;
    const fetchImpl = makeFetch((url) => {
      calls++;
      if (url === "https://hop.test/first") return htmlResponse("", 302, { location: "/second" });
      return htmlResponse("done");
    });
    const res = await safeFetch(
      "https://hop.test/first",
      makeOptions({ dns, fetchImpl: fetchImpl as FetchLike }),
    );
    expect(res.url).toBe("https://hop.test/second");
    expect(res.redirects).toBe(1);
    expect(calls).toBe(2);
  });
});

describe("redirects", () => {
  it("follows a same-site redirect", async () => {
    const fetchImpl = makeFetch((url) =>
      url.endsWith("/one") ? htmlResponse("", 302, { location: "/two" }) : htmlResponse("final"),
    );
    const res = await safeFetch("https://a.test/one", makeOptions({ fetchImpl }));
    expect(res.text).toBe("final");
    expect(res.redirects).toBe(1);
  });

  it("sends configured headers on the initial request and every redirect hop", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = makeFetch((url, init) => {
      inits.push(init ?? {});
      return url.endsWith("/one")
        ? htmlResponse("", 302, { location: "/two" })
        : htmlResponse("final");
    });
    const res = await safeFetch(
      "https://a.test/one",
      makeOptions({ fetchImpl, headers: { "user-agent": "do-sift/0.1 (contact)" } }),
    );
    expect(res.redirects).toBe(1);
    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect((init.headers as Record<string, string>)["user-agent"]).toBe("do-sift/0.1 (contact)");
    }
  });

  it("sends no headers when none are configured", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      inits.push(init ?? {});
      return htmlResponse("ok");
    });
    await safeFetch("https://a.test/one", makeOptions({ fetchImpl }));
    expect(inits[0]?.headers).toBeUndefined();
  });

  it("refuses a redirect to a private IP literal", async () => {
    const fetchImpl = makeFetch(() =>
      htmlResponse("", 302, { location: "http://127.0.0.1/admin" }),
    );
    const p = safeFetch("https://a.test/one", makeOptions({ fetchImpl }));
    await expect(kindOfAsync(p)).resolves.toBe("private-ip");
  });

  it("refuses a redirect to a host that resolves private", async () => {
    const lookupTargets = new Map<string, string[]>([
      ["a.test", [PUBLIC_V4]],
      ["rebind.test", ["192.168.0.9"]],
    ]);
    const dns: DnsResolver = { lookup: async (h) => lookupTargets.get(h) ?? [] };
    const fetchImpl = makeFetch((url) =>
      url === "https://a.test/one"
        ? htmlResponse("", 302, { location: "https://rebind.test/" })
        : htmlResponse("x"),
    );
    const p = safeFetch("https://a.test/one", makeOptions({ dns, fetchImpl }));
    await expect(kindOfAsync(p)).resolves.toBe("private-ip");
  });

  it("refuses https→http downgrades", async () => {
    const fetchImpl = makeFetch(() => htmlResponse("", 302, { location: "http://b.test/" }));
    const p = safeFetch("https://a.test/one", makeOptions({ fetchImpl }));
    await expect(kindOfAsync(p)).resolves.toBe("redirect");
  });

  it("refuses exceeding the redirect limit", async () => {
    let n = 0;
    const fetchImpl = makeFetch(() => htmlResponse("", 302, { location: `/hop${++n}` }));
    const p = safeFetch("https://a.test/start", makeOptions({ fetchImpl, maxRedirects: 2 }));
    await expect(kindOfAsync(p)).resolves.toBe("redirect");
  });

  it("refuses a redirect without a location header", async () => {
    const fetchImpl = makeFetch(() => htmlResponse("", 302, {}));
    const p = safeFetch("https://a.test/one", makeOptions({ fetchImpl }));
    await expect(kindOfAsync(p)).resolves.toBe("redirect");
  });
});

describe("limits", () => {
  it("enforces the byte cap", async () => {
    const fetchImpl = makeFetch(() => htmlResponse("x".repeat(1000)));
    const p = safeFetch("https://big.test/", makeOptions({ fetchImpl, maxBytes: 100 }));
    await expect(kindOfAsync(p)).resolves.toBe("size");
  });

  it("enforces the timeout via abort", async () => {
    const fetchImpl = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const p = safeFetch("https://slow.test/", makeOptions({ fetchImpl, timeoutMs: 25 }));
    await expect(kindOfAsync(p)).resolves.toBe("timeout");
  });

  it("enforces the MIME allowlist", async () => {
    const pdf = makeFetch(
      () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
    );
    const p1 = safeFetch("https://f.test/doc.pdf", makeOptions({ fetchImpl: pdf }));
    await expect(kindOfAsync(p1)).resolves.toBe("mime");

    const noType = makeFetch(
      () => new Response("data", { headers: { "content-type": "image/png" } }),
    );
    const p2 = safeFetch("https://f.test/doc", makeOptions({ fetchImpl: noType }));
    await expect(kindOfAsync(p2)).resolves.toBe("mime");
  });

  it("refuses non-2xx statuses", async () => {
    const fetchImpl = makeFetch(() => htmlResponse("nope", 500));
    const p = safeFetch("https://err.test/", makeOptions({ fetchImpl }));
    await expect(kindOfAsync(p)).resolves.toBe("status");
  });
});

describe("happy path", () => {
  it("returns final content with provenance fields", async () => {
    const fetchImpl = makeFetch((url) =>
      url === "https://ok.test/start"
        ? htmlResponse("", 302, { location: "https://ok.test/end" })
        : new Response("<html>hello</html>", {
            status: 200,
            headers: { "content-type": "application/xhtml+xml" },
          }),
    );
    const res = await safeFetch("https://ok.test/start", makeOptions({ fetchImpl }));
    expect(res.url).toBe("https://ok.test/end");
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/xhtml+xml");
    expect(res.text).toBe("<html>hello</html>");
    expect(res.redirects).toBe(1);
    expect(res.bytes.byteLength).toBe(18);
  });

  it("skips DNS for IP-literal hosts (already validated)", async () => {
    const dns: DnsResolver = { lookup: async () => [] };
    const res = await safeFetch(`http://${PUBLIC_V4}/x`, makeOptions({ dns }));
    expect(res.text).toBe("<p>ok</p>");
  });
});

/**
 * Charset-aware text decode (SRC-20, QUAL run-010 finding): the recorded
 * page (tedmontgomery.com) serves windows-1252 `<P>•` bullets with NO
 * charset declaration anywhere (no Content-Type param, no meta) — the
 * UTF-8-default decode mangled 0x95 to U+FFFD in stored passages. Decode
 * order is WHATWG: Content-Type charset param, then a meta-charset sniff
 * (first 1024 bytes, text/html only), then the HTML default
 * windows-1252; everything else stays UTF-8; an unknown label falls back
 * to UTF-8 rather than throwing.
 */
describe("charset-aware text decode (SRC-20)", () => {
  /** Serve raw bytes — the windows-1252 shapes cannot be expressed as
   * UTF-8 Response strings. */
  function bytesResponse(bytes: Uint8Array, contentType: string): FetchLike {
    type Body = ConstructorParameters<typeof Response>[0];
    return makeFetch(
      () => new Response(bytes as Body, { headers: { "content-type": contentType } }),
    );
  }

  // "<P>" + 0x95 (windows-1252 bullet) + " A" — the verbatim run-010 shape
  const RUN010_PAGE = new Uint8Array([0x3c, 0x50, 0x3e, 0x95, 0x20, 0x41]);
  // "caf" + 0xe9 (windows-1252 é)
  const CAFE_1252 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  // "caf" + 0xc3 0xa9 (UTF-8 é)
  const CAFE_UTF8 = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);

  it("decodes undeclared text/html as windows-1252 (the recorded run-010 fix)", async () => {
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({ fetchImpl: bytesResponse(RUN010_PAGE, "text/html") }),
    );
    expect(res.text).toBe("<P>\u2022 A"); // • — not U+FFFD
  });

  it("honors the Content-Type charset param over the default", async () => {
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({ fetchImpl: bytesResponse(CAFE_UTF8, "text/html; charset=utf-8") }),
    );
    expect(res.text).toBe("café");
  });

  it("honors a meta charset when the header declares none", async () => {
    const page = new Uint8Array([
      ...'<html><head><meta charset="iso-8859-1"></head><body>caf'
        .split("")
        .map((c) => c.charCodeAt(0)),
      0xe9,
    ]);
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({ fetchImpl: bytesResponse(page, "text/html") }),
    );
    expect(res.text).toContain("café");
  });

  it("keeps undeclared text/plain on UTF-8 (JSON/API path unchanged)", async () => {
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({ fetchImpl: bytesResponse(CAFE_UTF8, "text/plain") }),
    );
    expect(res.text).toBe("café");
    // and a windows-1252 text/plain stays mangled — the boundary is
    // honest: WHATWG defaults windows-1252 for text/html only
    const latin = await safeFetch(
      `http://${PUBLIC_V4}/y`,
      makeOptions({ fetchImpl: bytesResponse(CAFE_1252, "text/plain") }),
    );
    expect(latin.text).toContain("\uFFFD");
  });

  it("falls back to UTF-8 on an unknown charset label instead of throwing", async () => {
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({
        fetchImpl: bytesResponse(CAFE_UTF8, "text/html; charset=x-not-a-real-charset"),
      }),
    );
    expect(res.text).toBe("café");
  });
});

describe("transport-only mode (SRC-24, enforceResponsePolicy: false)", () => {
  it("returns non-2xx statuses to the caller instead of throwing (429 retry envelopes)", async () => {
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({
        fetchImpl: makeFetch(() => htmlResponse("slow down", 429, { "retry-after": "7" })),
        enforceResponsePolicy: false,
      }),
    );
    expect(res.status).toBe(429);
    // retry envelopes read Retry-After off the response headers
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("returns a non-JSON 200 without the MIME guard firing (adapters own the typed error)", async () => {
    const res = await safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({
        fetchImpl: makeFetch(
          () =>
            new Response("<html>gateway status page</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        ),
        allowedMimePrefixes: ["application/json"],
        enforceResponsePolicy: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("gateway status page");
  });

  it("still refuses private resolutions before any socket", async () => {
    const p = safeFetch(
      "http://pinned.test/x",
      makeOptions({ dns: makeDns(["127.0.0.1"]), enforceResponsePolicy: false }),
    );
    await expect(kindOfAsync(p)).resolves.toBe("private-ip");
  });

  it("keeps the size cap in transport mode", async () => {
    const big = "x".repeat(70 * 1024);
    const p = safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({ fetchImpl: makeFetch(() => htmlResponse(big)), enforceResponsePolicy: false }),
    );
    await expect(kindOfAsync(p)).resolves.toBe("size");
  });
});

describe("external signal (SRC-24, SafeFetchOptions.signal)", () => {
  it("aborts the in-flight request when the caller's signal fires", async () => {
    const controller = new AbortController();
    const never = new Promise<Response>(() => {});
    const p = safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({
        fetchImpl: makeFetch(() => never),
        signal: controller.signal,
        timeoutMs: 10_000,
      }),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(kindOfAsync(p)).resolves.toBe("timeout");
  });

  it("refuses before dispatch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const p = safeFetch(
      `http://${PUBLIC_V4}/x`,
      makeOptions({
        fetchImpl: makeFetch(() => {
          called++;
          return htmlResponse("x");
        }),
        signal: controller.signal,
      }),
    );
    await expect(kindOfAsync(p)).resolves.toBe("timeout");
    expect(called).toBe(0);
  });
});
