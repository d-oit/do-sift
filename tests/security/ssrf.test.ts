/**
 * Consolidated SSRF negatives (CORE-10): the LAYERED fetch gate as the
 * pipeline actually composes it — site-access policy verdict first, then
 * safe-fetch guards. Each test is an attack that crosses two layers; the
 * per-layer unit suites (packages/safe-fetch, plugin-policy-siteaccess)
 * cover the layers themselves.
 */
import { describe, expect, it } from "vitest";
import {
  safeFetch,
  type DnsResolver,
  type FetchLike,
  type SafeFetchOptions,
} from "@do-sift/safe-fetch";
import { createSiteAccessPolicy, type SiteAccessInstance } from "@do-sift/plugin-policy-siteaccess";

const PUBLIC = "203.0.113.10";

async function policyLayer(): Promise<SiteAccessInstance> {
  const policy = createSiteAccessPolicy();
  await policy.activate({
    pluginName: "policy-siteaccess",
    config: {},
    events: { emit: () => {} },
  } as unknown as Parameters<SiteAccessInstance["activate"]>[0]);
  return policy;
}

function fetchOptions(dns: DnsResolver, fetchImpl: FetchLike): SafeFetchOptions {
  return { maxBytes: 64 * 1024, timeoutMs: 5_000, maxRedirects: 3, dns, fetchImpl };
}

function kindOfError(e: unknown): string {
  return e instanceof Error && "kind" in e ? String((e as { kind: unknown }).kind) : "other";
}

describe("layered fetch gate (CORE-10 SSRF negatives)", () => {
  it("the policy layer refuses deny-listed sites before any fetch; IP literals are safe-fetch's layer", async () => {
    const policy = await policyLayer();
    let fetchAttempts = 0;
    const fetchImpl: FetchLike = async () => {
      fetchAttempts++;
      return new Response("x", { headers: { "content-type": "text/plain" } });
    };

    // site policy: linkedin (and subdomains) denied before dialing
    for (const hostile of [
      "https://www.linkedin.com/posts/x",
      "https://linkedin.com:443/in/x",
      "https://sub.linkedin.com/",
    ]) {
      expect(policy.check(new URL(hostile).hostname).allowed, hostile).toBe(false);
    }
    // private-IP and metadata literals pass the SITE policy layer…
    expect(policy.check("127.0.0.1").allowed).toBe(true);
    expect(policy.check("169.254.169.254").allowed).toBe(true);
    // …and are the safe-fetch layer's refusals, proven per-host below.
    for (const hostile of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/internal",
      "http://2130706433/", // obfuscated 127.0.0.1
    ]) {
      const dns: DnsResolver = { lookup: async () => [] };
      await expect(safeFetch(hostile, fetchOptions(dns, fetchImpl))).rejects.toMatchObject({
        kind: "private-ip",
      });
    }
    expect(fetchAttempts).toBe(0); // nothing was ever dialed
  });

  it("safe-fetch layer refuses private DNS answers even when the policy allows the host", async () => {
    const policy = await policyLayer();
    const host = "rebind.test";
    expect(policy.check(host).allowed).toBe(true); // policy is fine with it…

    const rebindDns: DnsResolver = { lookup: async () => ["10.0.0.9"] };
    let dialed = false;
    const fetchImpl: FetchLike = async () => {
      dialed = true;
      return new Response("nope", { headers: { "content-type": "text/plain" } });
    };
    await expect(
      safeFetch(`https://${host}/`, fetchOptions(rebindDns, fetchImpl)),
    ).rejects.toMatchObject({ kind: "private-ip" });
    expect(dialed).toBe(false); // …but safe-fetch never dials a private answer
  });

  it("a redirect from an allowed host to a deny-listed host is refused by the per-hop policy hook before dialing", async () => {
    const policy = await policyLayer();
    const dns: DnsResolver = { lookup: async () => [PUBLIC] };
    const dialLog: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      dialLog.push(url);
      if (url === "https://allowed.test/one") {
        return new Response("", {
          status: 302,
          headers: { "content-type": "text/html", location: "https://www.linkedin.com/lure" },
        });
      }
      return new Response("x", { headers: { "content-type": "text/plain" } });
    };

    // the composition wires the site-access policy into safe-fetch's
    // per-hop checkHost hook (the gap CORE-10 exposed and closed)
    const options: SafeFetchOptions = {
      ...fetchOptions(dns, fetchImpl),
      checkHost: (host) => policy.assertAllowed(host),
    };
    await expect(safeFetch("https://allowed.test/one", options)).rejects.toThrow(
      /site access denied for www\.linkedin\.com/,
    );
    // only the original host was dialed — the lure never saw a request
    expect(dialLog).toHaveLength(1);
  });

  it("a redirect to a host that resolves private is refused by safe-fetch", async () => {
    const policy = await policyLayer();
    const lookupTargets = new Map<string, string[]>([
      ["allowed.test", [PUBLIC]],
      ["lure.test", ["192.168.0.9"]],
    ]);
    const dns: DnsResolver = { lookup: async (h) => lookupTargets.get(h) ?? [] };
    expect(policy.check("lure.test").allowed).toBe(true); // policy cannot see DNS

    const fetchImpl: FetchLike = async (url) =>
      url === "https://allowed.test/one"
        ? new Response("", {
            status: 302,
            headers: { "content-type": "text/html", location: "https://lure.test/x" },
          })
        : new Response("x", { headers: { "content-type": "text/plain" } });

    await expect(
      safeFetch("https://allowed.test/one", fetchOptions(dns, fetchImpl)),
    ).rejects.toMatchObject({ kind: "private-ip" });
  });

  it("mixed public+private DNS answers fail closed", async () => {
    const policy = await policyLayer();
    const host = "mixed.test";
    expect(policy.check(host).allowed).toBe(true);
    const dns: DnsResolver = { lookup: async () => [PUBLIC, "10.0.0.9"] };
    await expect(
      safeFetch(
        `https://${host}/`,
        fetchOptions(
          dns,
          async () => new Response("x", { headers: { "content-type": "text/plain" } }),
        ),
      ),
    ).rejects.toMatchObject({ kind: "private-ip" });
  });
});

describe("verdict kind sanity", () => {
  it("safe-fetch errors carry precise kinds", async () => {
    const dns: DnsResolver = { lookup: async () => ["127.0.0.1"] };
    try {
      await safeFetch(
        "https://loopback.test/",
        fetchOptions(
          dns,
          async () => new Response("x", { headers: { "content-type": "text/plain" } }),
        ),
      );
      expect.unreachable();
    } catch (e) {
      expect(kindOfError(e)).toBe("private-ip");
    }
  });
});
