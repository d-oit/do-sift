import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { AuthService, StaticOidcVerifier } from "@do-sift/auth";
import { MetricsRegistry, createResearchServer, listen } from "../src/index.js";

const auth = new AuthService(new StaticOidcVerifier({}), {
  allowlist: ["owner-alice"],
  devBypass: true,
  devOwner: "owner-alice",
});

let server: Server;
let base: string;

beforeAll(async () => {
  server = createResearchServer({
    auth,
    metrics: new MetricsRegistry(),
    runResearch: async () => ({ answerable: false }) as never,
  });
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(() => {
  server.close();
});

describe("MetricsRegistry", () => {
  it("counts requests by fixed route labels and renders Prometheus text", () => {
    const registry = new MetricsRegistry();
    registry.observe({
      type: "http.request",
      requestId: "r1",
      method: "GET",
      path: "/random/unknown/path",
      status: 404,
      outcome: "client_error",
      durationMs: 3,
    });
    registry.observe({
      type: "answer.suspect",
      requestId: "r2",
      passages: 4,
      markers: ["x"],
    });
    const text = registry.render();
    expect(text).toContain(
      'do_sift_http_requests_total{method="GET",route="other",outcome="client_error",status="404"} 1',
    );
    expect(text).not.toContain("random/unknown");
    expect(text).toContain("do_sift_answer_suspect_total 1");
    expect(text).toContain("do_sift_answer_suspect_passages_total 4");
  });
});

describe("GET /metrics", () => {
  it("serves text exposition to an authenticated owner (loopback dev bypass)", async () => {
    await fetch(`${base}/healthz`);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# TYPE do_sift_http_requests_total counter");
    expect(body).toContain('route="/healthz"');
  });

  it("refuses unauthenticated scrapes when the dev bypass is off", async () => {
    const locked = createResearchServer({
      auth: new AuthService(new StaticOidcVerifier({}), {
        allowlist: ["owner-alice"],
        devBypass: false,
      }),
      metrics: new MetricsRegistry(),
      runResearch: async () => ({ answerable: false }) as never,
    });
    const port = await listen(locked);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(401);
    } finally {
      locked.close();
    }
  });

  it("refuses non-GET methods", async () => {
    const res = await fetch(`${base}/metrics`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
