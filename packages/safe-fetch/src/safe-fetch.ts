/**
 * safe-fetch orchestrator (CORE-06, ADR 0003 evidence provenance).
 *
 * Host-side module — plugins never call this directly; the kernel/storage
 * layer mediates it. Guards compose in this order for every hop including
 * redirects: URL sanity → DNS resolution → address validation → fetch with
 * manual redirects → status → MIME → streamed size cap → timeout.
 *
 * DNS and fetch are injected so the whole pipeline is testable offline
 * (INV-006). In production the caller injects a resolver that pins lookup
 * results for the connection; verify-then-fetch leaves a small TOCTOU
 * window that pinning closes (recorded as an open risk in plans/002).
 */
import { SafeFetchError, assertPublicAddress, assertPublicHttpUrl, parseIpv4 } from "./guards.js";
import { pinnedRequest } from "./pinned-transport.js";

export interface DnsResolver {
  /** Resolve a hostname to every address the resolver returns. */
  lookup(host: string): Promise<readonly string[]>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Accepted Content-Type prefixes (after stripping parameters); defaults to DEFAULT_MIME_PREFIXES. */
  allowedMimePrefixes?: readonly string[];
  dns: DnsResolver;
  /**
   * Transport override (tests and custom callers). When UNDEFINED — the
   * production default — safe-fetch uses its own pinned-IP transport
   * (SRC-23): the socket connects DIRECTLY to an address the guard
   * validated, closing the R-11 re-resolution window; https SNI and
   * certificate identity stay the hostname. When PROVIDED, every request
   * delegates to it and the caller owns re-resolution behavior.
   */
  fetchImpl?: FetchLike | undefined;
  /**
   * Per-hop site-policy hook (CORE-10): called with the hostname of the
   * initial URL AND every redirect target before anything is dialed.
   * Throw to refuse. Without it, a redirect could hop from an allowed
   * host to one a site policy denies — the hook closes that gap.
   */
  checkHost?: ((host: string) => void) | undefined;
  /**
   * Extra request headers sent on EVERY hop (initial + redirects) — e.g.
   * the descriptive User-Agent that provider etiquette (Wikimedia UA
   * policy, 2026) requires. Transport metadata only: no guard decision
   * ever depends on these.
   */
  headers?: Record<string, string>;
  /**
   * External cancellation (SRC-24): aborted by the caller (e.g. an
   * adapter's AbortSignal.any envelope) in addition to the internal
   * deadline. The surface that fires is distinguishable via the thrown
   * error in the pinnedFetch wrapper; inside safeFetch both map to the
   * timeout kind as before.
   */
  signal?: AbortSignal | undefined;
  /**
   * Transport-only mode (SRC-24): when FALSE, non-2xx statuses and
   * unaccepted MIME types are RETURNED instead of thrown — for callers
   * that own their own status envelopes (the search adapters' 429/502/503/
   * 504 retry logic and JSON validation). Every pre-response guard
   * (scheme/IP/DNS/redirect/site-policy/size/time) stays enforced.
   */
  enforceResponsePolicy?: boolean | undefined;
}

export const DEFAULT_MIME_PREFIXES: readonly string[] = Object.freeze([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
]);

export interface SafeFetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  /** Response headers of the final hop (SRC-24: e.g. retry-after for callers with status envelopes). */
  headers: Headers;
  bytes: Uint8Array;
  text: string;
  redirects: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULTS = {
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 3,
};

function isIpLiteralHost(hostname: string): boolean {
  if (hostname.startsWith("[")) return true;
  return parseIpv4(hostname) !== null;
}

/** Resolve the host and refuse any non-public answer. IP literals skip DNS.
 * Returns the VALIDATED addresses (SRC-23): the pinned transport connects
 * directly to one of them instead of re-resolving. */
async function resolveAndValidate(url: URL, dns: DnsResolver): Promise<readonly string[]> {
  if (isIpLiteralHost(url.hostname)) {
    // already validated by assertPublicHttpUrl; bare the IP for the socket
    return [url.hostname.replace(/^\[|\]$/gu, "")];
  }
  const addrs = await dns.lookup(url.hostname);
  if (addrs.length === 0) {
    throw new SafeFetchError("dns", `no addresses resolved for ${url.hostname}`);
  }
  for (const addr of addrs) assertPublicAddress(addr);
  return addrs;
}

function assertAcceptedMime(contentType: string, allowed: readonly string[]): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.length === 0 || !allowed.some((p) => base.startsWith(p))) {
    throw new SafeFetchError("mime", `content-type "${contentType}" is not accepted`);
  }
  return base;
}

/** Fetch with a hard byte cap by consuming the body stream incrementally. */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  abort: AbortController,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new SafeFetchError("size", `body exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
    abort.abort(); // stop the underlying connection once we have what we need
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Fetch one URL under all guards. Throws SafeFetchError with a precise
 * `kind` on every refusal; never follows a hop that has not been
 * re-validated. https→http downgrades are refused by default.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const mimes = options.allowedMimePrefixes ?? DEFAULT_MIME_PREFIXES;

  const abort = new AbortController();
  // SRC-24: an external signal (an adapter's envelope) aborts alongside
  // the internal deadline; both surface through the same controller.
  const external = options.signal;
  if (external !== undefined) {
    if (external.aborted) abort.abort();
    else external.addEventListener("abort", () => abort.abort(), { once: true });
  }
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let current = assertPublicHttpUrl(rawUrl);
    let redirects = 0;

    for (;;) {
      if (abort.signal.aborted) {
        throw new SafeFetchError("timeout", `deadline ${timeoutMs}ms exceeded before fetch`);
      }
      // site-policy hook runs on EVERY hop (initial + each redirect target)
      options.checkHost?.(current.hostname);
      await resolveAndValidate(current, options.dns);

      // SRC-23: the addresses returned by validation PIN the connection
      // when the pinned transport is used — the socket never re-resolves.
      const addresses = await resolveAndValidate(current, options.dns);
      let status: number;
      let responseHeaders: Headers;
      let body: ReadableStream<Uint8Array> | null;
      if (options.fetchImpl === undefined) {
        // production default: the stdlib pinned transport (R-11 closure)
        const pinned = await pinnedRequest(current, {
          addresses,
          headers: options.headers ?? {},
          signal: abort.signal,
        });
        status = pinned.status;
        responseHeaders = pinned.headers;
        body = pinned.body;
      } else {
        let rejectAbort: ((e: SafeFetchError) => void) | undefined;
        const onAbort = (): void =>
          rejectAbort?.(new SafeFetchError("timeout", `deadline ${timeoutMs}ms exceeded`));
        try {
          const init: RequestInit = { signal: abort.signal, redirect: "manual" };
          if (options.headers !== undefined) init.headers = options.headers;
          // Race the transport against the abort controller: an injected
          // fetchImpl may never settle, so the abort must REJECT the await
          // itself (SRC-24 external-signal semantics).
          const abortPromise = new Promise<never>((_, reject) => {
            rejectAbort = reject;
          });
          if (abort.signal.aborted) onAbort();
          else abort.signal.addEventListener("abort", onAbort, { once: true });
          const fetchPromise = options.fetchImpl(current.toString(), init);
          void fetchPromise.catch(() => {}); // the loser of the race must not crash the process
          const res = await Promise.race([fetchPromise, abortPromise]);
          status = res.status;
          responseHeaders = res.headers;
          body = res.body;
        } catch (e) {
          if (abort.signal.aborted) {
            throw new SafeFetchError("timeout", `deadline ${timeoutMs}ms exceeded`);
          }
          throw e;
        } finally {
          abort.signal.removeEventListener("abort", onAbort);
        }
      }

      if (REDIRECT_STATUSES.has(status)) {
        if (redirects >= maxRedirects) {
          throw new SafeFetchError("redirect", `more than ${maxRedirects} redirects`);
        }
        const location = responseHeaders.get("location");
        if (!location) {
          throw new SafeFetchError("redirect", `redirect ${status} without location`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new SafeFetchError("redirect", `unparseable redirect target "${location}"`);
        }
        const validated = assertPublicHttpUrl(next.toString());
        if (validated.protocol === "http:" && current.protocol === "https:") {
          throw new SafeFetchError("redirect", "refusing https→http downgrade");
        }
        await body?.cancel();
        current = validated;
        redirects++;
        continue;
      }

      if (status < 200 || status > 299) {
        // transport-only mode (SRC-24) returns the status instead — the
        // caller owns its status envelope; body still capped and discarded
        if (options.enforceResponsePolicy !== false) {
          await body?.cancel();
          throw new SafeFetchError("status", `unexpected status ${status} for ${current.host}`);
        }
        const bytesOnly = await readBodyCapped(body, maxBytes, abort);
        return {
          url: current.toString(),
          status,
          contentType: responseHeaders.get("content-type") ?? "",
          headers: responseHeaders,
          bytes: bytesOnly,
          text: "",
          redirects,
        };
      }
      const contentType = responseHeaders.get("content-type") ?? "";
      if (options.enforceResponsePolicy !== false) {
        assertAcceptedMime(contentType, mimes);
      }
      const bytes = await readBodyCapped(body, maxBytes, abort);
      const text = decodeBody(bytes, contentType);
      return {
        url: current.toString(),
        status,
        contentType,
        headers: responseHeaders,
        bytes,
        text,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

const CHARSET_PARAM = /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/iu;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/iu;

/**
 * The WHATWG windows-1252 index for 0x80–0x9F — the range where the
 * encoding differs from ISO-8859-1 (€‚ƒ„…†‡ˆ‰Š‹ŒŽ''""•–—˜™š›œžŸ).
 * Positions 0x81, 0x8D, 0x8F, 0x90, 0x9D are unmapped → U+FFFD. Needed in
 * code because Node's TextDecoder decodes the windows-1252 LABELS
 * latin1-style (0x95 → U+0095 control) instead of applying this table.
 */
const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

const WINDOWS_1252_LABELS = new Set(["windows-1252", "cp1252", "iso-8859-1", "latin1"]);

/** WHATWG windows-1252 decode: bytes ≤0x7F and ≥0xA0 are identical to
 * latin1; only the 0x80–0x9F range uses the table above. */
function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out +=
      b <= 0x7f || b >= 0xa0
        ? String.fromCharCode(b)
        : String.fromCharCode(WINDOWS_1252_HIGH[b - 0x80] as number);
  }
  return out;
}

/**
 * Charset-aware text decode (SRC-20, QUAL run-010 finding): WHATWG
 * ordering — the Content-Type charset param wins, then (text/html only) a
 * meta-charset sniff over the first 1024 bytes, then the HTML default
 * windows-1252 for undeclared text/html and UTF-8 for everything else.
 * The windows-1252 family (incl. the iso-8859-1/latin1 aliases, per
 * WHATWG) uses the table decoder above because Node's TextDecoder does
 * not implement the high table; an unknown label falls back to UTF-8
 * rather than throwing. Security guards are untouched: this runs AFTER
 * mime validation and the byte cap, and changes only how the
 * already-fetched bytes become text.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const param = CHARSET_PARAM.exec(contentType)?.[1];
  let label = param?.toLowerCase();
  if (label === undefined && mime === "text/html") {
    const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024));
    label = META_CHARSET.exec(head)?.[1]?.toLowerCase();
  }
  if (label !== undefined && WINDOWS_1252_LABELS.has(label)) return decodeWindows1252(bytes);
  if (label === undefined && mime === "text/html") return decodeWindows1252(bytes);
  try {
    return new TextDecoder(label ?? "utf-8", { fatal: false }).decode(bytes);
  } catch {
    // unknown/unsupported label — pre-SRC-20 behavior
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export {
  SafeFetchError,
  assertPublicAddress,
  assertPublicHttpUrl,
  expandIpv6,
  isPrivateIpv4,
  isPrivateIpv6,
  parseIpv4,
} from "./guards.js";
export type { SafeFetchFailureKind } from "./guards.js";

export interface PinnedFetchOptions {
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  maxRedirects?: number | undefined;
  dns: DnsResolver;
  /** Per-hop site-policy hook, same semantics as safeFetch's. */
  checkHost?: ((host: string) => void) | undefined;
  headers?: Record<string, string> | undefined;
}

/**
 * A FetchLike on the pinned-IP pipeline (SRC-24): every request runs the
 * full guard pipeline (scheme/IP/DNS/site-policy per hop, pinned connect,
 * redirects, size and deadline caps) in TRANSPORT-ONLY mode — non-2xx
 * statuses and unaccepted MIME are RETURNED as a real Response so callers
 * with their own status envelopes (the search adapters' 429/502/503/504
 * retry logic and JSON validation) keep working unchanged.
 *
 * Error-name mapping preserves the adapters' envelopes exactly: the
 * internal deadline OR an external `AbortSignal.timeout` surface as an
 * Error named "TimeoutError"; a plain caller abort surfaces as "AbortError";
 * guard refusals (private answer, denied host, …) propagate as SafeFetchError.
 */
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
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
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
