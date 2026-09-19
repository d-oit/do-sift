/**
 * Pinned-IP transport (SRC-23, R-11 closure). safe-fetch's `dns` option
 * only feeds per-hop VALIDATION; when the caller delegates transport to
 * the global fetch (or any injected FetchLike), the actual connection
 * re-resolves the hostname through the OS resolver — a TOCTOU window in
 * which a rebinding DNS server can answer validation with a public IP
 * and the connect with a private one (R-11).
 *
 * This module is the stdlib transport that closes it: the caller passes
 * ADDRESSES ALREADY VALIDATED by the guard, and the socket connects
 * directly to one of them — no name resolution happens at connect time.
 * For https, `servername` keeps SNI and certificate validation anchored
 * to the HOSTNAME (connect-by-IP alone would break both). The Host
 * header is set to the original host so name-based virtual hosts work.
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { SafeFetchError } from "./guards.js";

export interface PinnedResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

export interface PinnedRequestOptions {
  /** Validated addresses to connect to — never a hostname. */
  addresses: readonly string[];
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** The bare IP for a URL hostname: strips v6 brackets; v4 and bare v6
 * pass through. Returns undefined for non-IP hostnames (caller never
 * passes one — addresses come from the guard's validation). */
function ipFamily(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

export async function pinnedRequest(url: URL, opts: PinnedRequestOptions): Promise<PinnedResponse> {
  const address = opts.addresses[0];
  if (address === undefined) {
    throw new SafeFetchError("dns", "pinned transport called without a validated address");
  }
  const family = ipFamily(address);
  const hostHeader = url.host; // hostname(:port) as the Host header expects
  const secure = url.protocol === "https:";
  const module = secure ? https : http;

  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = module.request(
      {
        // connect DIRECTLY to the validated address — no name resolution
        host: address,
        family,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // SNI + certificate identity stay the HOSTNAME, not the IP
        ...(secure ? { servername: url.hostname } : {}),
        headers: { ...opts.headers, host: hostHeader },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
          } else if (value !== undefined) {
            headers.append(key, value);
          }
        }
        resolve({
          status,
          headers,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );
    req.on("error", (e) => {
      if (opts.signal.aborted) {
        reject(new SafeFetchError("timeout", `pinned transport aborted: ${e.message}`));
        return;
      }
      reject(new SafeFetchError("network", `connect/request failed: ${e.message}`));
    });
    opts.signal.addEventListener(
      "abort",
      () => {
        req.destroy(new SafeFetchError("timeout", "deadline exceeded"));
      },
      { once: true },
    );
    req.end();
  });
}
