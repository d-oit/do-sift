# Ethical guardrails as code (ADR 0005, issue #124)

The browser/computer automation guardrails are **declarative policy plus one
reviewable evaluator**, not test fixtures and not logic spread through plugin
code. This page is the operator/contributor guide: what is enforced, where the
rules live, and how to extend them safely.

## What is enforced

| Guardrail                         | Rule                                                                                                                        | Authority |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------- |
| Default-deny                      | A decision the policy does not explicitly allow is denied                                                                   | ADR 0005  |
| No stealth                        | `fingerprint-spoofing`, `headless-evasion`, `webdriver-masking`, `proxy-rotation-for-evasion` are prohibited action classes | INV-004   |
| No CAPTCHA bypass                 | `captcha-solving`, `captcha-bypass`, `captcha-service` are prohibited action classes                                        | INV-004   |
| No credential entry by automation | `type-credential` is a prohibited action; the browser harness additionally refuses credential-shaped selectors              | ADR 0005  |
| Bot-prohibiting sites             | `linkedin.com` (and any future shipped entry) is denied before any other layer                                              | INV-007   |
| Explicit grants                   | `browser` and `computer` cannot act without a recorded owner grant                                                          | INV-003   |
| Consent                           | `computer` actions require interactive per-class consent                                                                    | ADR 0005  |

## Where the policy lives

| File                                                    | Role                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/contracts/src/guardrails.json`                | **The policy document.** Declarative, standalone, versioned with the contracts package.         |
| `packages/contracts/src/guardrails.ts`                  | Schema, integrity floor, and the evaluator (`evaluateGuardrails`, `createGuardrailEngine`).     |
| `packages/kernel/src/kernel.ts`                         | Validates the policy at construction and injects a policy-bound engine as `context.guardrails`. |
| `packages/plugins/plugin-harness-browser/src/index.ts`  | Consults the engine for every `navigate`/`scroll`/`type`/`click`.                               |
| `packages/plugins/plugin-harness-computer/src/index.ts` | Consults the engine for every `open`/`type`/`click`/`scroll`/`key`.                             |
| `tests/security/guardrails.test.ts`                     | Policy tests in the `npm run check` pipeline.                                                   |

The kernel refuses to start with a policy that weakens the shipped
guarantees, and plugins only receive an engine scoped to the automation
capabilities they declared.

## Decision order

`evaluateGuardrails` is pure and fail-closed. The first matching rule wins:

1. `unknown-capability` — no capability named, or one the plugin does not declare.
2. `prohibited-action` — the action appears in any `prohibited` category.
3. `action-not-permitted` — the action is not in the capability's `allowedActions`.
4. `site-access-required` — a site-scoped action (`navigate`) has no host.
5. `site-default-deny` — the host matches `siteAccess.defaultDenySites` (subdomains, ports, and trailing dots included).
6. `grant-required` — the capability needs a recorded grant and none is present.
7. `consent-required` — the capability needs interactive consent and none is asserted.
8. `permitted` — otherwise allowed.

Every denial carries a `reason` that names the rule and its authority, so run
logs (`deniedBy`) explain themselves without reading the code.

## How to extend the guardrails

### Add a bot-prohibiting site to the default-deny list

1. Add the registrable domain to `siteAccess.defaultDenySites` in
   `packages/contracts/src/guardrails.json` (lowercase, no scheme or `www.`).
2. Add the same entry to `DEFAULT_DENY_SITES` in
   `packages/contracts/src/sitepolicy.ts`. `scripts/policy.ts` reads that file
   for INV-007, and `tests/security/guardrails.test.ts` fails if the two lists
   diverge.
3. Run `npx vitest run tests/security/guardrails.test.ts`.

Shrinking the list is not an extension: `assertGuardrailsIntegrity` rejects a
policy that drops a shipped entry, so removal needs a new ADR.

### Prohibit a new action class

Add the action identifier to the relevant category under `prohibited`, or add
a new category (categories are open-ended). If the boundary is new, cite it in
the policy's `authority` block and in ADR 0005's consequences. The integrity
floor requires the `stealth` and `captcha` categories to stay non-empty.

### Allow or block an action for a capability

Edit `capabilities.<browser|computer>.allowedActions`. Narrowing is safe.
Widening still has to pass the prohibited categories and the site gate, and
`scripts/policy.ts` keeps scanning harness sources for stealth/CAPTCHA
patterns (INV-004), so a widened action name cannot smuggle evasion in.

### Change what a harness runs

Harnesses call `context.guardrails.assertAllowed({ capability, action, host })`
before touching their driver. A new action kind must be added to the policy
first; otherwise it is denied by `action-not-permitted`. Never catch a
`GuardrailError` and continue — the run log must record the denial
(`deniedBy`) as the harnesses do.

### Add a new decision rule

Only needed when a new _kind_ of decision appears: add a `GuardrailRule` and a
branch in `evaluateGuardrails`, then add cases to
`tests/security/guardrails.test.ts`. Keep the order above: prohibitions and
site denials must stay ahead of grants, and grants ahead of consent.

## Why not run an OPA binary?

The issue proposed OPA/Rego. This repository is Node-only (ADR 0001) and its
check pipeline is hermetic (`npm run check` runs TypeScript tools only);
adding `opa` would require a Go toolchain plus a `.github/workflows` change,
which is an approval boundary. A JSON policy document with a typed evaluator
gives the properties that matter — externalized, versionable, auditable,
default-deny, test-covered policy — with no new runtime. If OPA is adopted
later, `guardrails.json` maps directly onto a Rego `data` document and
`tests/security/guardrails.test.ts` becomes the `opa test` parity suite.

## Rego export

`policies/guardrails.rego` is an OPA-readable mirror of the JSON document:
the same default-deny decision, the same prohibited stealth/captcha/
credential-entry classes, the same `linkedin.com` deny list with sub-domain
semantics, and the same per-capability allowed actions plus grant/consent/
site-access gates. It is an export, not a second enforcer — the kernel
still executes the TypeScript evaluator.

`scripts/guardrails-check.ts` (the `guardrails` step in `npm run
check:fast` and the dev-signal `guardrails` sensor) parses the Rego data sets
and compares each with `guardrails.json` in both directions: a site, action,
or gate that is missing from the Rego, listed under the wrong set, present
only in a comment, or left behind after the JSON dropped it is a finding, so
the two cannot drift. The comparison lives in `scripts/guardrails/sync.ts`.
Extending the policy means: edit the JSON first, mirror the value in the
matching Rego set, then run the gate. See
[0011-rego-guardrails-export.md](decisions/0011-rego-guardrails-export.md)
for the decision.

## Verifying a change

```bash
npx vitest run tests/security/guardrails.test.ts   # policy + wiring tests
npx vitest run scripts/guardrails/test/sync.test.ts # Rego export sync gate
npm run check                                       # full pipeline (tests included)
npm run policy                                      # INV-004 / INV-007 scanners
```
