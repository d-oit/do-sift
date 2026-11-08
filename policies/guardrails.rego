# Ethical guardrails — Rego export of the shipped policy (issue #124).
#
# Declarative, auditable mirror of `packages/contracts/src/guardrails.json`
# (schemaVersion "1", ADR 0005). The JSON document is the single source of
# truth and the TypeScript evaluator in `packages/contracts/src/guardrails.ts`
# is what the kernel executes (Node-only pipeline, ADR 0001 — no OPA binary
# in `npm run check`). This file exists so OPA consumers can load the same
# rules as a Rego `data` document; `scripts/guardrails-check.ts` fails the
# pipeline when this file drifts from the JSON.
#
# Decision order mirrors `evaluateGuardrails`:
# unknown-capability → prohibited-action → action-not-permitted →
# site-access-required → site-default-deny → grant-required →
# consent-required → permitted. Default decision is deny.
package do_sift.guardrails

# Shipped bot-prohibiting sites (INV-007). Extending this set is a policy
# change; shrinking it needs a new ADR (`assertGuardrailsIntegrity` rejects
# a policy that drops a shipped entry).
default_deny_sites := {"linkedin.com"}

# Prohibited action classes (INV-004). The integrity floor requires the
# stealth and captcha categories to stay non-empty.
prohibited_stealth := {
	"fingerprint-spoofing",
	"headless-evasion",
	"webdriver-masking",
	"proxy-rotation-for-evasion",
}

prohibited_captcha := {
	"captcha-solving",
	"captcha-bypass",
	"captcha-service",
}

prohibited_credential_entry := {"type-credential"}

# Per-capability gates from the policy document.
grant_required := {"browser", "computer"}

consent_required := {"computer"}

site_access_required := {"browser"}

site_scoped_actions := {"navigate"}

allowed_actions := {
	"browser": {"navigate", "scroll", "type", "click"},
	"computer": {"open", "type", "click", "scroll", "key"},
}

# Deny when the host matches a shipped default-deny site or sub-domain.
default_denied(host) if {
	some site in default_deny_sites
	host == site
}

default_denied(host) if {
	some site in default_deny_sites
	endswith(host, concat(".", ["", site]))
}

# The verdict. `grant`/`consent` are the recorded owner grant and the
# asserted interactive consent for the action class.
default decision := "deny"

decision := "deny" if {
	not allowed_actions[input.capability]
}

decision := "deny" if {
	input.action in prohibited_stealth
}

decision := "deny" if {
	input.action in prohibited_captcha
}

decision := "deny" if {
	input.action in prohibited_credential_entry
}

decision := "deny" if {
	not input.action in allowed_actions[input.capability]
}

decision := "deny" if {
	input.capability in site_access_required
	input.action in site_scoped_actions
	not input.host
}

decision := "deny" if {
	input.capability in site_access_required
	input.action in site_scoped_actions
	default_denied(input.host)
}

decision := "deny" if {
	input.capability in grant_required
	not input.grant
}

decision := "deny" if {
	input.capability in consent_required
	not input.consent
}

decision := "allow" if {
	allowed_actions[input.capability][input.action]
	not input.action in prohibited_stealth
	not input.action in prohibited_captcha
	not input.action in prohibited_credential_entry
	not site_denied(input)
	not grant_missing(input)
	not consent_missing(input)
}

site_denied(input) if {
	input.capability in site_access_required
	input.action in site_scoped_actions
	not input.host
}

site_denied(input) if {
	input.capability in site_access_required
	input.action in site_scoped_actions
	default_denied(input.host)
}

grant_missing(input) if {
	input.capability in grant_required
	not input.grant
}

consent_missing(input) if {
	input.capability in consent_required
	not input.consent
}
