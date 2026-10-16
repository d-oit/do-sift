import { describe, expect, it } from "vitest";
import { OwnerLimiter } from "../src/server.js";

describe("OwnerLimiter (#63)", () => {
  it("caps concurrent runs per owner and releases slots", () => {
    const limiter = new OwnerLimiter(
      { maxConcurrentPerOwner: 2, maxRequestsPerMinute: 100 },
      () => 0,
    );
    const a = limiter.acquire("alice");
    const b = limiter.acquire("alice");
    expect("release" in a && "release" in b).toBe(true);
    expect(limiter.acquire("alice")).toMatchObject({ retryAfterSec: 1 });
    // a different owner is unaffected
    expect("release" in limiter.acquire("bob")).toBe(true);
    if ("release" in a) a.release();
    expect("release" in limiter.acquire("alice")).toBe(true);
  });

  it("caps requests per minute with a Retry-After hint, then recovers", () => {
    let t = 0;
    const limiter = new OwnerLimiter(
      { maxConcurrentPerOwner: 10, maxRequestsPerMinute: 2 },
      () => t,
    );
    for (let i = 0; i < 2; i++) {
      const adm = limiter.acquire("alice");
      if ("release" in adm) adm.release();
    }
    t = 30_000;
    expect(limiter.acquire("alice")).toMatchObject({ retryAfterSec: 30 });
    t = 60_001;
    expect("release" in limiter.acquire("alice")).toBe(true);
  });

  it("release is idempotent", () => {
    const limiter = new OwnerLimiter(
      { maxConcurrentPerOwner: 1, maxRequestsPerMinute: 100 },
      () => 0,
    );
    const adm = limiter.acquire("alice");
    if (!("release" in adm)) throw new Error("expected admission");
    adm.release();
    adm.release();
    expect("release" in limiter.acquire("alice")).toBe(true);
    expect(limiter.acquire("alice")).toMatchObject({ retryAfterSec: 1 });
  });
});
