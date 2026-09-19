/**
 * Pinned-IP transport (SRC-23, R-11 closure). Two layers:
 *
 * 1. Direct unit tests of pinnedRequest against a real loopback server —
 *    status/headers/body passthrough, Host header = the original host
 *    (name-based vhosts keep working), deadline enforcement.
 *
 * 2. A behavioral pin proof through safeFetch: the URL's hostname is
 *    resolved ONLY by the injected stub to TEST-NET 203.0.113.10
 *    (unroutable, never answered by real DNS). The pinned transport
 *    CONNECTS to that address and hangs into the deadline (kind:
 *    "timeout"); a re-resolving transport would fail OS resolution of
 *    the fake hostname fast with a network error instead.
 *
 * safeFetch's guards refuse loopback/private addresses BEFORE any socket
 * by design, so end-to-end safeFetch tests against a loopback server are
 * impossible on purpose — the injected fetchImpl suite (safe-fetch.test.ts)
 * covers the guard loop, this file covers the transport itself.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeFetch, pinnedRequest, type DnsResolver } from "../src/index.js";

let server: Server;
let port = 0;
let lastHost = "";
let requests = 0;

beforeEach(async () => {
  server = createServer((req, res) => {
    requests++;
    lastHost = req.headers.host ?? "";
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<p>ok</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  lastHost = "";
  requests = 0;
});

describe("pinnedRequest (direct)", () => {
  it("connects to the given address; Host header stays the original host", async () => {
    const res = await pinnedRequest(new URL(`http://localhost:${port}/x`), {
      addresses: ["127.0.0.1"],
      headers: {},
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.body.getReader().read();
    expect(new TextDecoder().decode(text.value)).toBe("<p>ok</p>");
    expect(lastHost).toBe(`localhost:${port}`);
  });

  it("passes redirect statuses through for the caller's loop to handle", async () => {
    const res = await pinnedRequest(new URL(`http://localhost:${port}/redirect`), {
      addresses: ["127.0.0.1"],
      headers: {},
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/final");
    expect(requests).toBe(1);
  });

  it("aborts into the timeout kind when the deadline fires", async () => {
    const hang = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const hangPort = (hang.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 120);
      await expect(
        pinnedRequest(new URL(`http://localhost:${hangPort}/x`), {
          addresses: ["127.0.0.1"],
          headers: {},
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      await new Promise<void>((resolve) => hang.close(() => resolve()));
    }
  });
});

describe("safeFetch uses the pinned transport by default (behavioral pin proof)", () => {
  it("connects to the VALIDATED address (TEST-NET hang) instead of re-resolving", async () => {
    // The stub is the ONLY resolver for pinned.test; its answer is
    // unroutable TEST-NET. Pinning → the connect hangs → timeout.
    // Re-resolving → OS lookup of the fake host fails fast → network.
    const stubDns: DnsResolver = { lookup: async () => ["203.0.113.10"] };
    await expect(
      safeFetch("http://pinned.test/x", {
        maxBytes: 64 * 1024,
        timeoutMs: 400,
        maxRedirects: 3,
        dns: stubDns,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  }, 10_000);

  it("still refuses private answers before any socket is opened", async () => {
    const privateDns: DnsResolver = { lookup: async () => ["127.0.0.1"] };
    await expect(
      safeFetch("http://pinned.test/x", {
        maxBytes: 64 * 1024,
        timeoutMs: 2_000,
        maxRedirects: 3,
        dns: privateDns,
      }),
    ).rejects.toMatchObject({ kind: "private-ip" });
    expect(requests).toBe(0);
  });
});
