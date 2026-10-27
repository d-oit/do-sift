/** Charset-aware decoding, transport-only mode, and external cancellation (SRC-20, SRC-24). */
import { describe, expect, it } from "vitest";
import { safeFetch, type FetchLike } from "../src/index.js";
import {
  PUBLIC_V4,
  makeDns,
  makeFetch,
  htmlResponse,
  makeOptions,
  kindOfAsync,
} from "./safe-fetch-support.js";
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
