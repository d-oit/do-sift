export {
  SafeFetchError,
  assertPublicAddress,
  assertPublicHttpUrl,
  expandIpv6,
  isPrivateIpv4,
  isPrivateIpv6,
  parseIpv4,
  safeFetch,
  DEFAULT_MIME_PREFIXES,
} from "./safe-fetch.js";
export type { SafeFetchFailureKind } from "./safe-fetch.js";
export type { DnsResolver, FetchLike, SafeFetchOptions, SafeFetchResult } from "./safe-fetch.js";
