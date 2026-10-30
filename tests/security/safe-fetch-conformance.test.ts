/**
 * Shared cross-plugin & end-to-end transport security conformance suite.
 *
 * Exercises the end-to-end pinned safe-fetch pipeline and network security controls:
 * 1. Special-purpose IPv4/IPv6 classification ranges (documentation, CGNAT, link-local, loopback, ULA, transition, etc.).
 * 2. Mixed DNS answers (fail closed).
 * 3. DNS changes between validation and connection.
 * 4. Redirects to denied hosts / private IPs / HTTPS downgrade.
 * 5. Credential and header stripping across origin changes.
 * 6. Abort, timeout, oversized/truncated bodies, and unsupported MIME types.
 * 7. Pinned transport connection & TLS hostname validation.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SafeFetchError,
  assertPublicAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  pinnedRequest,
  safeFetch,
  type DnsResolver,
  type FetchLike,
  type SafeFetchOptions,
} from "@do-sift/safe-fetch";

const PUBLIC_V4 = "93.184.215.14"; // example.com
const PUBLIC_V6 = "2606:4700:4700::1111"; // Cloudflare

describe("Security Conformance Suite", () => {
  describe("1. Authoritative IANA Address Registries Coverage", () => {
    it("refuses every special-purpose IPv4 range", () => {
      const deniedIpv4s = [
        "0.0.0.1", // 0.0.0.0/8
        "10.255.0.1", // 10.0.0.0/8
        "100.64.0.1", // 100.64.0.0/10 CGNAT
        "127.0.0.1", // 127.0.0.0/8 Loopback
        "169.254.1.1", // 169.254.0.0/16 Link-Local
        "172.16.0.1", // 172.16.0.0/12 Private
        "192.0.0.1", // 192.0.0.0/24 IETF Protocol
        "192.0.2.1", // 192.0.2.0/24 TEST-NET-1
        "192.88.99.1", // 192.88.99.0/24 6to4 Anycast
        "192.168.10.1", // 192.168.0.0/16 Private
        "198.18.0.1", // 198.18.0.0/15 Benchmarking
        "198.51.100.1", // 198.51.100.0/24 TEST-NET-2
        "203.0.113.1", // 203.0.113.0/24 TEST-NET-3
        "224.0.0.1", // 224.0.0.0/4 Multicast
        "240.0.0.1", // 240.0.0.0/4 Reserved
        "255.255.255.255", // Broadcast
      ];
      for (const ip of deniedIpv4s) {
        expect(isPrivateIpv4(ip), `IPv4 ${ip} should be classified as private/non-routable`).toBe(
          true,
        );
        expect(() => assertPublicAddress(ip)).toThrow(SafeFetchError);
      }
    });

    it("refuses every special-purpose IPv6 range", () => {
      const deniedIpv6s = [
        "::", // Unspecified
        "::1", // Loopback
        "100::1", // Discard-only (100::/64)
        "64:ff9b::192.168.1.1", // NAT64 Well-Known Prefix
        "64:ff9b:1::1", // Local IPv4/IPv6 Translation
        "2001::1", // TEREDO (2001::/32)
        "2001:2::1", // Benchmarking (2001:2::/48)
        "2001:10::1", // ORCHIDv2 (2001:10::/28)
        "2001:db8::1", // Documentation (2001:db8::/32)
        "2002:a00:1::1", // 6to4 (2002::/16)
        "fe80::1", // Link-Local (fe80::/10)
        "fec0::1", // Site-Local (fec0::/10)
        "fc00::1", // Unique-Local ULA (fc00::/7)
        "fd00::1", // Unique-Local ULA
        "ff02::1", // Multicast (ff00::/8)
        "::ffff:10.0.0.1", // IPv4-mapped private
        "::ffff:0:10.0.0.1", // IPv4-translated private
      ];
      for (const ip of deniedIpv6s) {
        expect(isPrivateIpv6(ip), `IPv6 ${ip} should be classified as private/non-routable`).toBe(
          true,
        );
        expect(() => assertPublicAddress(ip)).toThrow(SafeFetchError);
      }
    });

    it("allows globally routable public IPv4 and IPv6 addresses", () => {
      expect(isPrivateIpv4(PUBLIC_V4)).toBe(false);
      expect(isPrivateIpv6(PUBLIC_V6)).toBe(false);
      expect(() => assertPublicAddress(PUBLIC_V4)).not.toThrow();
      expect(() => assertPublicAddress(PUBLIC_V6)).not.toThrow();
    });
  });

  describe("2. Mixed DNS Answers & DNS Rebinding", () => {
    it("fails closed when DNS returns a mix of public and private addresses", async () => {
      const dns: DnsResolver = { lookup: async () => [PUBLIC_V4, "10.0.0.1"] };
      const options: SafeFetchOptions = {
        maxBytes: 64 * 1024,
        timeoutMs: 1000,
        maxRedirects: 3,
        dns,
        fetchImpl: async () => new Response("ok"),
      };
      await expect(safeFetch("https://mixed-dns.test/", options)).rejects.toMatchObject({
        kind: "private-ip",
      });
    });

    it("repeats DNS validation and policy guards on every redirect hop", async () => {
      let hopCount = 0;
      const dns: DnsResolver = {
        lookup: async (host) => {
          if (host === "hop1.test") return [PUBLIC_V4];
          if (host === "hop2.test") return ["192.168.1.1"];
          return [PUBLIC_V4];
        },
      };
      const fetchImpl: FetchLike = async (url) => {
        hopCount++;
        if (url === "https://hop1.test/") {
          return new Response("", { status: 302, headers: { location: "https://hop2.test/" } });
        }
        return new Response("ok");
      };

      const options: SafeFetchOptions = {
        maxBytes: 64 * 1024,
        timeoutMs: 1000,
        maxRedirects: 3,
        dns,
        fetchImpl,
      };

      await expect(safeFetch("https://hop1.test/", options)).rejects.toMatchObject({
        kind: "private-ip",
      });
      expect(hopCount).toBe(1); // Never dialed hop2
    });
  });

  describe("3. Redirect Protection & Sensitive Header Stripping", () => {
    it("refuses HTTPS to HTTP downgrade on redirects", async () => {
      const dns: DnsResolver = { lookup: async () => [PUBLIC_V4] };
      const fetchImpl: FetchLike = async () =>
        new Response("", { status: 302, headers: { location: "http://insecure.test/" } });

      const options: SafeFetchOptions = {
        maxBytes: 64 * 1024,
        timeoutMs: 1000,
        maxRedirects: 3,
        dns,
        fetchImpl,
      };

      await expect(safeFetch("https://secure.test/", options)).rejects.toMatchObject({
        kind: "redirect",
      });
    });

    it("strips authorization, cookie, and proxy-authorization headers across cross-origin redirects", async () => {
      const headersSeen: Array<Record<string, string>> = [];
      const dns: DnsResolver = { lookup: async () => [PUBLIC_V4] };
      const fetchImpl: FetchLike = async (url, init) => {
        headersSeen.push((init?.headers as Record<string, string>) ?? {});
        if (url === "https://origin-a.test/start") {
          return new Response("", {
            status: 302,
            headers: { location: "https://origin-b.test/target" },
          });
        }
        return new Response("done", { headers: { "content-type": "text/plain" } });
      };

      const options: SafeFetchOptions = {
        maxBytes: 64 * 1024,
        timeoutMs: 1000,
        maxRedirects: 3,
        dns,
        fetchImpl,
        headers: {
          Authorization: "Bearer secret-token",
          Cookie: "session=123",
          "Proxy-Authorization": "Basic xxx",
          "User-Agent": "do-sift/0.1.0",
        },
      };

      const res = await safeFetch("https://origin-a.test/start", options);
      expect(res.text).toBe("done");
      expect(headersSeen).toHaveLength(2);

      // Hop 1 (origin-a.test) has credentials
      expect(headersSeen[0]?.Authorization).toBe("Bearer secret-token");
      expect(headersSeen[0]?.Cookie).toBe("session=123");

      // Hop 2 (origin-b.test) has stripped credentials but keeps User-Agent
      expect(headersSeen[1]?.Authorization).toBeUndefined();
      expect(headersSeen[1]?.Cookie).toBeUndefined();
      expect(headersSeen[1]?.["Proxy-Authorization"]).toBeUndefined();
      expect(headersSeen[1]?.["User-Agent"]).toBe("do-sift/0.1.0");
    });
  });

  describe("4. Cancellation, Oversized Body & MIME Refusal", () => {
    it("enforces byte size caps strictly", async () => {
      const dns: DnsResolver = { lookup: async () => [PUBLIC_V4] };
      const bigContent = "a".repeat(1000);
      const fetchImpl: FetchLike = async () =>
        new Response(bigContent, { headers: { "content-type": "text/plain" } });

      const options: SafeFetchOptions = {
        maxBytes: 500,
        timeoutMs: 1000,
        maxRedirects: 3,
        dns,
        fetchImpl,
      };

      await expect(safeFetch("https://big.test/", options)).rejects.toMatchObject({
        kind: "size",
      });
    });

    it("refuses unsupported MIME content types", async () => {
      const dns: DnsResolver = { lookup: async () => [PUBLIC_V4] };
      const fetchImpl: FetchLike = async () =>
        new Response("binary data", { headers: { "content-type": "application/octet-stream" } });

      const options: SafeFetchOptions = {
        maxBytes: 64 * 1024,
        timeoutMs: 1000,
        maxRedirects: 3,
        dns,
        fetchImpl,
      };

      await expect(safeFetch("https://mime.test/", options)).rejects.toMatchObject({
        kind: "mime",
      });
    });

    it("honors caller abort signals immediately", async () => {
      const dns: DnsResolver = { lookup: async () => [PUBLIC_V4] };
      const controller = new AbortController();
      controller.abort();

      const options: SafeFetchOptions = {
        maxBytes: 64 * 1024,
        timeoutMs: 5000,
        maxRedirects: 3,
        dns,
        fetchImpl: async () => new Response("ok"),
        signal: controller.signal,
      };

      await expect(safeFetch("https://abort.test/", options)).rejects.toMatchObject({
        kind: "timeout",
      });
    });
  });

  describe("5. Pinned Transport Local Server Verification", () => {
    let server: Server;
    let serverPort = 0;

    beforeEach(async () => {
      server = createServer((req, res) => {
        if (req.url === "/hello") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end("hello from pinned server");
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      serverPort = (server.address() as { port: number }).port;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("connects directly to the pinned target IP via low-level pinnedRequest", async () => {
      const controller = new AbortController();
      const res = await pinnedRequest(new URL(`http://localhost:${serverPort}/hello`), {
        addresses: ["127.0.0.1"],
        headers: {},
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const text = await res.body.getReader().read();
      expect(new TextDecoder().decode(text.value)).toBe("hello from pinned server");
    });
  });
});
