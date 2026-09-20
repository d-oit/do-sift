/**
 * pinnedFetch (SRC-24): the Response-shaped FetchLike the composition
 * hands to the search adapters when no fetchImpl is injected (R-11
 * closure completed for search API calls). Same two-layer proof shape as
 * pinned-transport.test.ts: the injected stub resolver answers TEST-NET
 * ONLY — a pinned connect hangs into the deadline (TimeoutError, the
 * error name the adapters map), a re-resolving transport would hit the
 * OS resolver for the fake host and fail fast with something else.
 *
 * safeFetch's guards refuse loopback/private addresses BEFORE any socket
 * by design, so end-to-end tests against a loopback server are
 * impossible on purpose; the DOMException name mapping and the guard
 * pipeline are what this file pins.
 */
import { describe, expect, it } from "vitest";
import { pinnedFetch, type DnsResolver } from "../src/index.js";

const TEST_NET = "203.0.113.10";

describe("pinnedFetch (SRC-24)", () => {
  it("connects to the VALIDATED address (TEST-NET hang) and maps the deadline to TimeoutError", async () => {
    const dns: DnsResolver = { lookup: async () => [TEST_NET] };
    const fetchLike = pinnedFetch({ dns, timeoutMs: 400 });
    await expect(fetchLike("http://pinned.test/search")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  }, 10_000);

  it("maps a caller abort to AbortError (the name the adapters map to the 'aborted' kind)", async () => {
    const dns: DnsResolver = { lookup: async () => [TEST_NET] };
    const fetchLike = pinnedFetch({ dns, timeoutMs: 10_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(
      fetchLike("http://pinned.test/search", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  }, 10_000);

  it("refuses private resolutions before any socket (guard pipeline intact)", async () => {
    const dns: DnsResolver = { lookup: async () => ["10.1.2.3"] };
    const fetchLike = pinnedFetch({ dns });
    await expect(fetchLike("http://pinned.test/search")).rejects.toMatchObject({
      kind: "private-ip",
    });
  });

  it("refuses to dispatch when the caller's signal is already aborted", async () => {
    const dns: DnsResolver = { lookup: async () => [TEST_NET] };
    const fetchLike = pinnedFetch({ dns });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchLike("http://pinned.test/search", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
