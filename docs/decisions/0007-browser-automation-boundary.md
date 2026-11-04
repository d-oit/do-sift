# 0007 — Browser automation is policy-gated, human-paced, and non-stealth

Status: accepted (first recorded 2026-09-06 in `plans/adr/0005-browser-ethics-boundary.md`)

## Context

Automation can be built to look human: spoofed fingerprints, patched
`navigator.webdriver`, solved CAPTCHAs. That is deception of the site operator,
and for sites whose terms prohibit automation it is a breach, not a clever
workaround. Separately, an automated browser is an egress path: it can reach
private addresses and metadata endpoints a fetch guard would block.

## Decision

Browser and computer automation are **declared policy**:

- The guardrails are a data document
  (`packages/contracts/src/guardrails.json`) evaluated by a typed engine the
  kernel injects, consulted **per action** by both harnesses.
- Default-deny for bot-prohibiting sites, LinkedIn included. The deny list is
  the literal source `scripts/policy.ts` scans (INV-007).
- Stealth, fingerprint spoofing, `navigator.webdriver` overrides, and CAPTCHA
  solving are rejected by the `noStealthPatterns` policy check (INV-004) —
  they are not "not yet implemented", they are out of scope.
- Computer automation is local-only, consent-gated, and off by default.
- Weakening the policy (dropping a denied site, un-gating a grant, emptying a
  prohibited class) throws in `assertGuardrailsIntegrity` and needs a record.

## Consequences

- Ethics is auditable: the rules are a versioned document with tests, not
  comments in a harness.
- A site whose terms change is a data edit plus a review, not a code change
  buried in an adapter.
- Some tasks simply cannot be automated. That is the intended outcome, and the
  answer to "can we automate LinkedIn?" is no.
- The deny list and the policy document cannot drift: a test fails if they
  diverge. See [guardrails.md](../guardrails.md) for how to extend them.
