# Changelog

All notable changes to do-sift are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer
with an explicit 0.x compatibility policy (minor = breaking, patch = safe).

## [0.1.0] — UNRELEASED

### Added

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
  policy (`DO_SIFT_FETCH_ALLOWLIST`), plus host HTML→text preprocessing
  before the readability extractor. Content is CC BY-SA — the evidence
  store preserves attribution per passage.
