# Security review — OPS-05 + SRC-06 change set (2026-09-14)

Scope: commits `6da2cc4` (packaged entrypoint), `748e1e8` (Wikipedia
adapter + live-fetch path), `b2a082d` (test headroom). Method: the
`review-security` skill — trust-boundary enumeration, recurring-offender
check, fixtures for every new finding class expressible as a test. This
is the review note the `add-plugin` rules require for the new plugin
(`plugin-search-wikipedia`) plus the entrypoint's new user-facing surface.

## Trust boundaries introduced

- **Inputs:** live search responses (Wikipedia — community-edited, so
  attacker-influenceable within vandalism windows); fetched page content
  (fully untrusted); redirects on every fetch hop; operator env config.
- **Outputs:** SSE events (JSON; the UI renders via `createTextNode`
  only); stored passages (data with provenance); startup logs (config
  facts only — no secrets exist in this posture).
- **Privilege:** zero new plugin capabilities; image runs non-root with a
  writable `/data`; no workflow or policy changes in the change set.

## Findings

1. **[PASS, by design] Search-hit URLs are host-pinned.** The adapter
   constructs URLs only on `en.wikipedia.org` (encoded titles cannot move
   the host; `/` is percent-encoded). The remaining lane — a compromised
   or captive network 302-ing the page fetch to an attacker host — is
   blocked per hop. Fixtures (both green, attacker host never requested):
   _apps/server: "refuses a redirect to a host outside the exhaustive
   allowlist"_, _"refuses a redirect to the shipped default-deny list
   under default posture"_.
2. **[PASS] `/healthz`** is unauthenticated by design: constant body
   `{"ok":true}`, no data, GET-only (404 otherwise).
3. **[PASS] Auth unchanged:** bearer or loopback-only dev bypass; the
   container smoke proved 401 across the docker bridge (dev bypass does
   not count non-loopback peers as loopback).
4. **[PASS] No raw `fs`/`net`/`http` imports** in `apps/` or the plugin —
   policy-enforced (`pluginImports`); the server type is derived from the
   factory's return type instead of `node:http`.
5. **[PASS, informational] `htmlToText` is preprocessing, not a
   sanitizer.** Its output is only ever rendered as data; entity decoding
   happens after tag stripping, so re-formed tags are inert. No markup
   path exists anywhere in the rendering chain (ANS-06 data-only rule).
6. **[LOW, residual] DNS-rebinding window** — safe-fetch validates the
   resolved address per hop, but the actual connect re-resolves via the
   OS resolver (safe-fetch's documented model; the caller may pin). This
   change set is safe-fetch's first production call site, so the residual
   is now real: recorded as **R-11**; mitigation direction is a pinned-IP
   fetch (IP URL + Host header) in the entrypoint.
7. **[LOW, residual] Prompt injection via fetched content.** Passage text
   is packed into the model prompt. Today the only model is the fixture
   (no live LLM, no live exposure); when a live model lands, fetched-text
   injection must be treated as adversarial input (ANS-02 + QUAL scope).
   Recorded as **R-12**.
8. **[PASS] Money:** no paid capability wired; `usage_ledger` untouched;
   budget caps intentionally not yet env-wirable (logged honestly).
9. **[PASS] Authz/cache:** no new owner-scoped query surfaces; the
   cross-owner and cache suites remain green (existing fixtures).
10. **[PASS] Workflows/plugins:** no `.github` changes; plugin declares
    zero capabilities; manifest network host is the single permitted host.

## Residual limitations

- "Validated citation exists" is **not** factual entailment (R-06): the
  citation gate proves a claim maps to stored evidence; it says nothing
  about the evidence's truth. No quality claims are made anywhere.
- Wikipedia content is CC BY-SA (attribution preserved per passage in the
  evidence store); publishing derived content requires the same license
  (dated record in `plans/sources.md`).

## Fixtures added

`apps/server/test/main.test.ts`: two redirect-refusal fixtures (exhaustive
allowlist mode; default posture + shipped deny list) — the first tests of
the composed live-fetch path refusing attacker-chosen hosts end-to-end.
