/**
 * Marginalia key management (issue #123, plan 038 — EXT-01).
 *
 * The adapter's supported default is the verified keyless legacy endpoint
 * (`api.marginalia.nu/public/search/...`). Marginalia's keyed api2 API exists
 * and takes an `API-Key` header, but the personal-key programme is closed as of
 * 2026-09-21 (`plans/sources.md`), so no key can be obtained today. These tests
 * pin the behaviour both ways: keyless when no secret name is configured,
 * keyed and header-carrying when one is — and fail-closed when a configured
 * name cannot be resolved.
 */
import { describe, expect, it } from "vitest";
import {
  createMarginaliaSearch,
  SearchProviderError,
  TermsGateError,
  type MarginaliaSearchDeps,
} from "../src/index.js";

const TERMS = {
  termsAcceptedAt: "2026-09-15",
  sourcesEntry: "Marginalia Search (marginalia.nu) — checked 2026-09-15",
};

/** Minimal recorded api2 response (docs shape, 2025-12-08 revision). */
const KEYED_RESPONSE = {
  license: "CC-BY-NC-SA 4.0",
  page: 1,
  pages: 3,
  query: "linear b",
  results: [
    {
      url: "https://example.test/linear-b",
      title: "Linear B",
      description: "Linear B is a syllabic script used for Mycenaean Greek.",
    },
  ],
};

type FetchLog = { url: string; init?: RequestInit | undefined }[];

interface CtxOptions {
  config: Record<string, unknown>;
  /** Secret names the network/manifest allowlist permits. */
  allowedSecrets?: string[];
  /** Resolved secret values by name; a missing name resolves to undefined. */
  secrets?: Record<string, string>;
  networkHosts?: string[];
}

function context(options: CtxOptions) {
  const assertedHosts: string[] = [];
  const resolvedNames: string[] = [];
  const ctx = {
    pluginName: "search-marginalia",
    config: options.config,
    events: { emit: () => {} },
    network: {
      assertHostAllowed: (host: string): void => {
        assertedHosts.push(host);
        const allowed = options.networkHosts ?? ["api.marginalia.nu", "api2.marginalia-search.com"];
        if (!allowed.includes(host)) throw new Error(`host ${host} is not allowed`);
      },
    },
    secrets: {
      assertNameAllowed: (name: string): void => {
        if (!(options.allowedSecrets ?? []).includes(name)) {
          throw new Error(`secret ${name} is not allowlisted`);
        }
      },
      resolve: async (name: string): Promise<string> => {
        resolvedNames.push(name);
        if (!(options.allowedSecrets ?? []).includes(name)) {
          throw new Error(`secret ${name} is not allowlisted`);
        }
        const value = options.secrets?.[name];
        if (value === undefined) throw new Error(`secret ${name} is not available`);
        return value;
      },
    },
    logger: { info: () => {}, warn: () => {} },
  };
  return {
    ctx: ctx as unknown as Parameters<ReturnType<typeof createMarginaliaSearch>["activate"]>[0],
    assertedHosts,
    resolvedNames,
  };
}

function deps(fetchLog: FetchLog, responses: Response[], retryCapMs = 1): MarginaliaSearchDeps {
  let call = 0;
  return {
    fetchImpl: async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      const res = responses[Math.min(call, responses.length - 1)]!;
      call++;
      return res;
    },
    retryCapMs,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("keyless default (no secret configured)", () => {
  it("keeps the verified legacy path and sends no credential", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(deps(fetchLog, [jsonResponse(KEYED_RESPONSE)]));
    const { ctx, assertedHosts } = context({ config: TERMS });
    await plugin.activate(ctx);
    expect(assertedHosts).toEqual(["api.marginalia.nu"]);

    await plugin.search({ text: "linear b", ownerId: "owner-a" }, { maxHits: 3, timeoutMs: 5000 });
    expect(fetchLog[0]?.url).toBe(
      `https://api.marginalia.nu/public/search/${encodeURIComponent("linear b")}`,
    );
    const headers = (fetchLog[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["API-Key"]).toBeUndefined();
  });

  it("treats an empty-string apiKeySecret as keyless instead of failing", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(deps(fetchLog, [jsonResponse(KEYED_RESPONSE)]));
    const { ctx, resolvedNames } = context({ config: { ...TERMS, apiKeySecret: "" } });
    await plugin.activate(ctx);
    expect(resolvedNames).toEqual([]);
    await plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 5000 });
    expect(fetchLog[0]?.url).toContain("api.marginalia.nu/public/search/");
  });
});

describe("keyed path (secret name configured)", () => {
  it("resolves the secret by name, asserts the api2 host, and sends the API-Key header", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(deps(fetchLog, [jsonResponse(KEYED_RESPONSE)]));
    const { ctx, assertedHosts, resolvedNames } = context({
      config: { ...TERMS, apiKeySecret: "MARGINALIA_API_KEY" },
      allowedSecrets: ["MARGINALIA_API_KEY"],
      secrets: { MARGINALIA_API_KEY: "test-key-123" },
    });
    await plugin.activate(ctx);

    expect(assertedHosts).toEqual(["api2.marginalia-search.com"]);
    expect(resolvedNames).toEqual(["MARGINALIA_API_KEY"]);

    const hits = await plugin.search(
      { text: "linear b", ownerId: "owner-a" },
      { maxHits: 3, timeoutMs: 5000 },
    );
    expect(hits).toHaveLength(1);
    expect(fetchLog[0]?.url).toBe(
      `https://api2.marginalia-search.com/search?query=${encodeURIComponent("linear b")}&count=3`,
    );
    const headers = (fetchLog[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["API-Key"]).toBe("test-key-123");
    expect(headers["user-agent"]).toBeTruthy();
  });

  it("never puts the key in the URL (a URL reaches logs and Referer headers)", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(deps(fetchLog, [jsonResponse(KEYED_RESPONSE)]));
    const { ctx } = context({
      config: { ...TERMS, apiKeySecret: "MARGINALIA_API_KEY" },
      allowedSecrets: ["MARGINALIA_API_KEY"],
      secrets: { MARGINALIA_API_KEY: "secret-value" },
    });
    await plugin.activate(ctx);
    await plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 5000 });
    expect(fetchLog[0]?.url).not.toContain("secret-value");
  });

  it("refuses activation when the configured secret name is not allowlisted", async () => {
    const plugin = createMarginaliaSearch(deps([], [jsonResponse(KEYED_RESPONSE)]));
    const { ctx } = context({
      config: { ...TERMS, apiKeySecret: "MARGINALIA_API_KEY" },
      allowedSecrets: [],
      secrets: { MARGINALIA_API_KEY: "k" },
    });
    await expect(plugin.activate(ctx)).rejects.toThrow(/not allowlisted/u);
  });

  it("refuses activation when the named secret resolves to nothing or empty", async () => {
    const plugin = createMarginaliaSearch(deps([], [jsonResponse(KEYED_RESPONSE)]));
    const missing = context({
      config: { ...TERMS, apiKeySecret: "MARGINALIA_API_KEY" },
      allowedSecrets: ["MARGINALIA_API_KEY"],
    });
    await expect(plugin.activate(missing.ctx)).rejects.toThrow(/not available/u);

    const empty = context({
      config: { ...TERMS, apiKeySecret: "MARGINALIA_API_KEY" },
      allowedSecrets: ["MARGINALIA_API_KEY"],
      secrets: { MARGINALIA_API_KEY: "   " },
    });
    await expect(plugin.activate(empty.ctx)).rejects.toThrow(/empty value/u);
  });

  it("rejects a non-string secret name rather than guessing a path", async () => {
    const plugin = createMarginaliaSearch(deps([], [jsonResponse(KEYED_RESPONSE)]));
    const { ctx } = context({ config: { ...TERMS, apiKeySecret: 42 } });
    await expect(plugin.activate(ctx)).rejects.toThrow(TermsGateError);
  });
});

describe("rate limiting and failure typing on the keyed path", () => {
  it("honors one Retry-After retry, then reports rate-limited", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(fetchLog, [
        jsonResponse({}, 429, { "retry-after": "0" }),
        jsonResponse({}, 429, { "retry-after": "0" }),
      ]),
    );
    const { ctx } = context({
      config: { ...TERMS, apiKeySecret: "MARGINALIA_API_KEY" },
      allowedSecrets: ["MARGINALIA_API_KEY"],
      secrets: { MARGINALIA_API_KEY: "k" },
    });
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: "rate-limited" });
    expect(fetchLog).toHaveLength(2); // original + exactly one retry
  });

  it("does not retry when the instructed Retry-After exceeds the cap", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(fetchLog, [jsonResponse({}, 429, { "retry-after": "120" })]),
    );
    const { ctx } = context({ config: TERMS });
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: "rate-limited" });
    expect(fetchLog).toHaveLength(1);
  });

  it("retries a gateway status once, then fails with a typed http error", async () => {
    const fetchLog: FetchLog = [];
    const plugin = createMarginaliaSearch(
      deps(fetchLog, [new Response("bad gateway", { status: 503 })], 5000),
    );
    const { ctx } = context({ config: TERMS });
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(SearchProviderError);
    expect(fetchLog).toHaveLength(2);
  });

  it("types a non-JSON 200 body as http rather than crashing", async () => {
    const plugin = createMarginaliaSearch(deps([], [new Response("<html>oops</html>")]));
    const { ctx } = context({ config: TERMS });
    await plugin.activate(ctx);
    await expect(
      plugin.search({ text: "q", ownerId: "owner-a" }, { maxHits: 1, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: "http" });
  });
});
