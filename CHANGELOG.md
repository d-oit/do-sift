# Changelog

All notable changes to do-sift are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer
with an explicit 0.x compatibility policy (minor = breaking, patch = safe).

## [0.1.0] — UNRELEASED

### Added

- Multi-tenant / multi-user authentication (#120, ADR 0010): a pluggable
  `AuthProvider` interface (`TenantId`, `Principal`, `AuthProviderError`) in
  `packages/contracts`, the reference `auth`-kind plugin
  `@do-sift/plugin-auth-oidc` (JWKS-verified OIDC id tokens → tenant-scoped
  principals), tenant-scoped storage (migration 0011 adds `tenants` and
  `tenant_id` to evidence/run/config tables, and every repository/FTS query
  filters on it), per-user/per-tenant capability grants in the kernel, and a
  cross-tenant leakage quality-gate test. The owner-allowlist `AuthService`
  remains the documented fallback (`docs/auth.md`).

- FND milestone: plugin kernel (`packages/kernel`) with manifest validation,
  capability grants, and lifecycle; shared contracts (`packages/contracts`);
  sample plugin; verification harness (`scripts/`); agent foundation
  (`AGENTS.md`, `.agents/skills/`, `plans/`); CI/security/scorecard/release
  workflow skeletons.
- Packaged service entrypoint (`apps/server`, OPS-05): env-configured
  composition of storage, auth, the RET-04 runtime, and the HTTP server;
  fail-closed provider selection (labeled fixtures only — live adapters
  stay behind their recorded gates); `/healthz` liveness route; the Docker
  image CMD now runs the service with a real healthcheck (build-time
  offline eval unchanged).
- First live search adapter (`plugin-search-wikipedia`, SRC-06): free,
  keyless MediaWiki action API behind the recorded terms gate
  (`plans/sources.md`, checked 2026-09-14); entrypoint live mode fetches
  pages through safe-fetch with every hop checked against the site-access
  policy (`DO_SIFT_FETCH_ALLOWLIST`). Content is CC BY-SA — the evidence
  store preserves attribution per passage.
- Plain-text content path (SRC-07): live page content now comes from the
  MediaWiki plain-text extract endpoint (`prop=extracts&explaintext=1`,
  same permitted host and terms) — no HTML-stripping pipeline exists, so
  template metadata cannot leak into stored passages. Fixes QUAL run-001
  finding F1; QUAL run-002 re-measured the same 8 live questions:
  extraction cleanliness 0.31 → 0.56, overall mean 0.775 → 0.85
  (single-annotator authorial labels, limits in docs/quality-gate.md).
  safe-fetch gained an opt-in `headers` option, and every live request
  carries a descriptive User-Agent per the Wikimedia UA policy (2026).
- Respectful 429 handling (SRC-07, 2026-09-14 policy research): the
  search adapter's single bounded retry honors `Retry-After` exactly
  (delay-seconds or HTTP-date), never retries before the instructed
  delay, and refuses to retry at all when the instruction exceeds the
  bounded cap — or when no usable header arrives and the 5 s etiquette
  floor does not fit the cap (never hot, never early).
