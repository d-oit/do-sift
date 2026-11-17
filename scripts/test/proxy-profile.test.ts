import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const caddy = readFileSync(join(process.cwd(), "deploy/caddy/Caddyfile"), "utf8");

describe("hardened reverse-proxy profile", () => {
  it("terminates TLS and hides the server header", () => {
    expect(caddy).toContain("tls internal");
    expect(caddy).toContain("-Server");
    expect(caddy).toContain("X-Content-Type-Options nosniff");
  });

  it("pins the upstream to loopback", () => {
    const upstreams = [...caddy.matchAll(/reverse_proxy\s+(\S+)/gu)].map((m) => m[1]);
    expect(upstreams.length).toBeGreaterThan(0);
    expect(upstreams.every((u) => u?.startsWith("127.0.0.1:"))).toBe(true);
  });

  it("refuses owner routes without a bearer header", () => {
    expect(caddy).toContain("not header Authorization");
    expect(caddy).toContain("respond @noauth 401");
  });

  it("caps bodies and rate-limits the API", () => {
    expect(caddy).toMatch(/max_size 8KB/u);
    expect(caddy).toMatch(/rate_limit\s*\{/u);
    expect(caddy).toMatch(/events \d+/u);
  });

  it("keeps health endpoints off the public edge", () => {
    expect(caddy).toContain("remote_ip private_ranges");
    expect(caddy).toContain("respond 403");
  });

  it("refuses encoded traversal variants before proxying", () => {
    expect(caddy).toContain("%2e");
    expect(caddy).toContain("%2f");
    expect(caddy).toContain("%5c");
  });
});
