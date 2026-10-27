/** Transport-only FetchLike on the pinned-IP pipeline (SRC-24): header merge and envelope-preserving error mapping. */
import { SafeFetchError } from "./guards.js";
import { safeFetch } from "./safe-fetch.js";
import type { DnsResolver, FetchLike } from "./safe-fetch.js";
export interface PinnedFetchOptions {
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  maxRedirects?: number | undefined;
  dns: DnsResolver;
  /** Per-hop site-policy hook, same semantics as safeFetch's. */
  checkHost?: ((host: string) => void) | undefined;
  headers?: Record<string, string> | undefined;
}
export function mergeRequestHeaders(
  factory: Record<string, string> | undefined,
  init: RequestInit | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(factory ?? {}) };
  const initHeaders = init?.headers;
  if (initHeaders === undefined || initHeaders === null) return merged;
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      merged[key] = value;
    });
    return merged;
  }
  if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) merged[key] = value;
    return merged;
  }
  return { ...merged, ...(initHeaders as Record<string, string>) };
}
export function pinnedFetch(options: PinnedFetchOptions): FetchLike {
  return async (url, init) => {
    const external = init?.signal ?? undefined;
    try {
      const result = await safeFetch(url, {
        maxBytes: options.maxBytes ?? 1_000_000,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxRedirects: options.maxRedirects ?? 3,
        dns: options.dns,
        ...(options.checkHost !== undefined ? { checkHost: options.checkHost } : {}),
        headers: mergeRequestHeaders(options.headers, init),
        ...(external !== undefined ? { signal: external } : {}),
        enforceResponsePolicy: false,
      });
      return new Response(result.bytes, {
        status: result.status,
        headers: result.headers,
      });
    } catch (e) {
      if (external !== undefined && external.aborted) {
        // distinguish the envelope's timeout signal from a plain cancel:
        // AbortSignal.timeout sets reason.name to "TimeoutError"
        const reasonName = (external.reason as { name?: string } | undefined)?.name;
        const err: Error & { name: string } =
          reasonName === "TimeoutError"
            ? Object.assign(new Error(`deadline exceeded`), { name: "TimeoutError" })
            : Object.assign(new Error(`aborted`), { name: "AbortError" });
        throw err;
      }
      if (e instanceof SafeFetchError && e.kind === "timeout") {
        throw Object.assign(new Error(e.message), { name: "TimeoutError" });
      }
      throw e;
    }
  };
}
