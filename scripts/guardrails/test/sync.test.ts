/**
 * Guardrails Rego sync tests (plan 041). Every fixture is the shipped
 * guardrails.json or guardrails.rego with one targeted mutation, so each test
 * fails for exactly the drift it names. Pure: runs the same on Windows, Linux,
 * macOS, and WSL2.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GuardrailsPolicy } from "@do-sift/contracts";
import { checkGuardrailsSync } from "../sync.js";

const ROOT = process.cwd();
const REGO = readFileSync(join(ROOT, "policies", "guardrails.rego"), "utf8");

function loadPolicy(): GuardrailsPolicy {
  const path = join(ROOT, "packages", "contracts", "src", "guardrails.json");
  return GuardrailsPolicy.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Apply literal replacements to the shipped Rego; each must match once. */
function regoWith(...pairs: Array<[string, string]>): string {
  let rego = REGO;
  for (const [from, to] of pairs) {
    expect(rego.split(from)).toHaveLength(2);
    rego = rego.replace(from, to);
  }
  return rego;
}

function expectFinding(findings: string[], ...parts: string[]): void {
  const hit = findings.some((f) => parts.every((part) => f.includes(part)));
  expect(hit, "expected a finding with " + parts.join(" + ") + " in:\n" + findings.join("\n")).toBe(
    true,
  );
}

describe("checkGuardrailsSync", () => {
  it("reports no findings for the shipped files", () => {
    expect(checkGuardrailsSync(loadPolicy(), REGO)).toEqual([]);
  });

  it("treats CRLF line endings exactly like LF (Windows checkouts)", () => {
    expect(checkGuardrailsSync(loadPolicy(), REGO.replace(/\n/gu, "\r\n"))).toEqual([]);
  });

  it("flags a JSON default-deny site missing from the Rego, naming the set", () => {
    const policy = loadPolicy();
    policy.siteAccess.defaultDenySites.push("example.com");
    expectFinding(checkGuardrailsSync(policy, REGO), "default_deny_sites", '"example.com"');
  });

  it("flags a stale Rego entry that the JSON no longer lists", () => {
    const rego = regoWith(['\t"captcha-service",\n', '\t"captcha-service",\n\t"captcha-farm",\n']);
    expectFinding(checkGuardrailsSync(loadPolicy(), rego), "prohibited_captcha", '"captcha-farm"');
  });

  it("does not accept a value that only appears in a comment", () => {
    const rego = regoWith(['\t"webdriver-masking",\n', '\t# retired: "webdriver-masking",\n']);
    expectFinding(
      checkGuardrailsSync(loadPolicy(), rego),
      "prohibited_stealth",
      '"webdriver-masking"',
    );
  });

  it("flags a value listed under the wrong set", () => {
    const rego = regoWith(
      ['\t"captcha-bypass",\n', ""],
      [
        '\t"proxy-rotation-for-evasion",\n',
        '\t"proxy-rotation-for-evasion",\n\t"captcha-bypass",\n',
      ],
    );
    const findings = checkGuardrailsSync(loadPolicy(), rego);
    expectFinding(findings, "prohibited_captcha", '"captcha-bypass"');
    expectFinding(findings, "prohibited_stealth", '"captcha-bypass"');
  });

  it("compares the consent, site-access, and site-scoped gates", () => {
    const policy = loadPolicy();
    policy.capabilities.browser.consentRequired = true;
    policy.capabilities.computer.siteAccessRequired = true;
    policy.capabilities.computer.siteScopedActions = ["open"];
    const findings = checkGuardrailsSync(policy, REGO);
    expectFinding(findings, "consent_required", '"browser"');
    expectFinding(findings, "site_access_required", '"computer"');
    expectFinding(findings, "site_scoped_actions", '"open"');
  });

  it("compares allowed actions per capability in both directions", () => {
    const policy = loadPolicy();
    policy.capabilities.browser.allowedActions.push("download");
    expectFinding(checkGuardrailsSync(policy, REGO), 'allowed_actions["browser"]', '"download"');

    const rego = regoWith([
      '"browser": {"navigate", "scroll", "type", "click"}',
      '"browser": {"navigate", "scroll", "type", "click", "key"}',
    ]);
    expectFinding(checkGuardrailsSync(loadPolicy(), rego), 'allowed_actions["browser"]', '"key"');
  });

  it("flags a capability that exists only in the Rego", () => {
    const rego = regoWith([
      "allowed_actions := {\n",
      'allowed_actions := {\n\t"network": {"fetch"},\n',
    ]);
    expectFinding(checkGuardrailsSync(loadPolicy(), rego), "allowed_actions", '"network"');
  });

  it("flags an unknown prohibited_* set in the Rego", () => {
    const rego = REGO + '\nprohibited_scraping := {"bulk-scrape"}\n';
    expectFinding(checkGuardrailsSync(loadPolicy(), rego), "prohibited_scraping");
  });

  it("fails closed when an expected data set is missing", () => {
    const rego = regoWith(["consent_required :=", "consent_needed :="]);
    expectFinding(checkGuardrailsSync(loadPolicy(), rego), "consent_required", "not found");
  });

  it("flags a lost default-deny decision", () => {
    const rego = regoWith(['default decision := "deny"', 'default decision := "allow"']);
    expectFinding(checkGuardrailsSync(loadPolicy(), rego), "default-deny");
  });

  it("reads set() as an empty set", () => {
    const policy = loadPolicy();
    policy.capabilities.computer.consentRequired = false;
    const rego = regoWith(['consent_required := {"computer"}', "consent_required := set()"]);
    expect(checkGuardrailsSync(policy, rego)).toEqual([]);
  });
});
