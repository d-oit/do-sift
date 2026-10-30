import { describe, expect, it } from "vitest";
import { CONTACT_URL, DEFAULT_VERSION, USER_AGENT, buildUserAgent } from "../src/common.js";

describe("User-Agent identity contract", () => {
  it("builds canonical User-Agent string with defaults", () => {
    expect(USER_AGENT).toBe(
      `do-sift/${DEFAULT_VERSION} (research-with-receipts engine; +${CONTACT_URL})`,
    );
  });

  it("supports custom version and contact URL", () => {
    const customUa = buildUserAgent("1.2.3", "https://example.com/support");
    expect(customUa).toBe(
      "do-sift/1.2.3 (research-with-receipts engine; +https://example.com/support)",
    );
  });

  it("falls back to defaults on blank inputs", () => {
    expect(buildUserAgent("", "")).toBe(USER_AGENT);
  });
});
