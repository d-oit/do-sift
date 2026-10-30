# `@do-sift/safe-fetch`

Guarded, pinned transport fetch pipeline for SSRF mitigation and evidence retrieval (CORE-06, SRC-23, SRC-24).

## Security Features & Boundary

1. **URL & IP Classification**: Strict WHATWG URL parsing. Rejects non-`http`/`https` schemes, embedded credentials, local hostnames (`localhost`, `.local`, `.internal`), and private/reserved IPv4 & IPv6 ranges based on authoritative IANA Special-Purpose Address Registries.
2. **DNS Rebinding Guard**: `safeFetch` resolves hostnames and validates EVERY address in the DNS lookup response. If ANY address falls into a private/reserved range, the request fails closed (`private-ip`).
3. **Pinned-IP Transport**: In production default mode, `safeFetch` connects directly to the address validated by DNS lookup without re-resolving (closing DNS rebinding windows). TLS hostname/SNI verification is preserved.
4. **Per-Hop Redirect Enforcement**: Every redirect hop re-executes URL, IP, DNS, and site-access policy checks. Cross-origin redirects strip sensitive headers (`Authorization`, `Cookie`, `Proxy-Authorization`). `https` -> `http` downgrades are refused.
5. **Resource Limits**: Configurable deadline timeouts, byte size caps, and strict accepted Content-Type MIME filters.

## Residual Limitations & Strategy

- **Single-Address Pinning (No Happy Eyeballs)**: The pinned transport currently pins to the first validated address returned by DNS lookup (`addresses[0]`). If the target host has multiple DNS answers and the first address fails to connect, `safe-fetch` does not attempt a secondary fallback address (no RFC 8305 Happy Eyeballs multi-address racing).
  - _Fallback Strategy_: Upstream callers (e.g. search adapters) handle retry logic across distinct requests if transient network failures occur. Future multi-address transport enhancements must re-validate every address in the candidate pool before racing connection attempts.
- **HTTP/1.1 Transport**: The pinned transport uses HTTP/1.1 over Node's `http`/`https`/`tls` sockets.
