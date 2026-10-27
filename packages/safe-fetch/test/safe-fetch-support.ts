/** Shared DNS/fetch seams for the safe-fetch guards (SRC-20, SRC-24). */
import {
  SafeFetchError,
  type DnsResolver,
  type FetchLike,
  type SafeFetchOptions,
} from "../src/index.js";
export const PUBLIC_V4 = "203.0.113.10";
export const PUBLIC_V6 = "2001:db8::10";
export function makeDns(addrs: string[]): DnsResolver {
  return { lookup: async () => addrs };
}
export function makeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchLike {
  return async (url, init) => handler(url, init);
}
export function htmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}
export function makeOptions(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
    maxRedirects: 3,
    dns: makeDns([PUBLIC_V4]),
    fetchImpl: makeFetch(() => htmlResponse("<p>ok</p>")),
    ...overrides,
  };
}
export function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SafeFetchError) return e.kind;
    throw e;
  }
  throw new Error("expected SafeFetchError");
}
export async function kindOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SafeFetchError) return e.kind;
    throw e;
  }
  throw new Error("expected SafeFetchError");
}
