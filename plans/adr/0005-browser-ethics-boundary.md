# ADR 0005 — Browser and computer automation boundaries

Status: accepted 2026-09-06

## Context

The product includes a browser harness and a computer (desktop) harness.
Browser automation "acting like a real human" can be legitimate (testing,
accessibility, sites that permit automation) or can mean evading bot
detection to automate sites that prohibit it — e.g., LinkedIn's User
Agreement prohibits automated access. We will not build the latter.

## Decision

**Browser harness (in scope):** human-paced interaction — natural delays,
scrolling, typed input, user-supplied logged-in profiles — permitted for
(a) sites whose terms/robots permit automation, (b) our own apps and tests,
(c) sites where the user demonstrates authorization (official API or written
permission). Every navigation passes the site-access policy plugin
(robots + ToS registry + allow/deny lists).

**Out of scope, non-negotiable (INV-004, pattern-enforced in CI):** stealth
or anti-detection techniques (fingerprint spoofing, headless-evasion,
proxy rotation to appear human), CAPTCHA solving, and default-enabled
automation of bot-prohibiting sites. **linkedin.com is on the shipped
default-deny list** (INV-007); connection to such services is possible only
through sanctioned APIs if they exist. Human pacing exists to be gentle on
sites and keep runs legible — never to evade bot detection.

**Computer harness:** local-only (no remote control surface), disabled by
default, interactive consent per action class, replayable action log, no
credential keystrokes (secrets injected via OS keychain only), no unattended
account access.

## Consequences

- The site-access policy and CI pattern checks are security controls;
  weakening them requires an ADR, not a code comment.
- Users who need data from bot-prohibiting sites are directed to official
  APIs or manual use; the product does not pretend otherwise.
