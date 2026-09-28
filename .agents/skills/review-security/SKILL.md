---
name: review-security
description: Security-review a do-sift change set — auth, fetching, plugin capabilities, rendering, budgets, and workflows — with attack-fixture evidence. Use before merging anything touching safe-fetch, the kernel, policies, CI workflows, or user-facing routes, or when the user asks for a security review.
---

# review-security

## Procedure

1. Enumerate the diff's trust boundaries: new inputs (network, files, user,
   plugin), new outputs (HTML, logs, stored data), and new privilege
   (capabilities, workflow permissions, secrets).
2. Check the recurring offenders:
   - **SSRF:** schemes, private/link-local/loopback/metadata IPs,
     IPv4-mapped IPv6, redirect revalidation, DNS rebinding pinning, size/
     time/MIME caps.
   - **Injection:** fetched content treated as data only; sanitized
     rendering; no raw provider HTML; prompt-injection fixtures pass.
   - **Authz:** owner scoping on every new query/route; cross-owner fixture
     test green; no cache hits across owners.
   - **Money:** budget reservation before calls; paid refusal without grant
     (INV-003); usage reconciliation.
   - **Plugins:** minimal capabilities; no raw `fs`/`net` imports in plugin
     source; grant enforcement tests.
   - **Workflows:** pinned action SHAs, least-privilege tokens, no
     `pull_request_target` with secrets, no untrusted-code execution with
     privileged tokens.
   - **Production requests:** request IDs, cancellation/deadlines, body and
     content-type limits, rate-limit ownership, readiness versus liveness, and
     structured logs that redact tokens, prompts, raw passages, and provider
     responses.
3. Use and extend the fixtures in `tests/security/`; add a fixture for every
   new finding class you can express as a test.
4. Report findings with severity, exploit sketch, and residual limitations.
   "Validated citation exists" is not factual entailment — say so wherever
   the report touches answer trust.

## Evidence

Fixture names + pass/fail, findings list, residual risks appended to
`plans/risks.md` when they outlive the PR.
