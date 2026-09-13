import { describe, expect, it } from "vitest";
import { DEFAULT_DENY_SITES, isSiteDenied } from "@do-sift/contracts";

describe("site-access default-deny (INV-007 / ADR 0005)", () => {
  it("denies bot-prohibiting sites including linkedin.com", () => {
    expect(DEFAULT_DENY_SITES.length).toBeGreaterThan(0);
    expect(DEFAULT_DENY_SITES).toContain("linkedin.com");
  });

  it("matches subdomains and www forms", () => {
    expect(isSiteDenied("linkedin.com")).toBe(true);
    expect(isSiteDenied("www.linkedin.com")).toBe(true);
    expect(isSiteDenied("www2.linkedin.com")).toBe(true);
  });

  it("does not over-match look-alike domains", () => {
    expect(isSiteDenied("notlinkedin.com")).toBe(false);
    expect(isSiteDenied("example.com")).toBe(false);
  });

  it("closes the port and trailing-dot bypasses (fail closed)", () => {
    expect(isSiteDenied("linkedin.com:443")).toBe(true);
    expect(isSiteDenied("www.linkedin.com:80")).toBe(true);
    expect(isSiteDenied("linkedin.com.")).toBe(true);
    expect(isSiteDenied("  LINKEDIN.COM  ")).toBe(true);
    expect(isSiteDenied("")).toBe(false); // empty is not a host; callers fail closed on their side
  });
});
