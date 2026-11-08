/**
 * Guardrails Rego export sync gate (issue #124).
 *
 * `policies/guardrails.rego` is an auditable OPA-readable export of the
 * shipped policy; `packages/contracts/src/guardrails.json` is the single
 * source of truth and the TypeScript evaluator is what the kernel executes
 * (Node-only pipeline, ADR 0001). This step fails `npm run check` when the
 * Rego export drifts from the JSON: every default-deny site, prohibited
 * action, allowed action, and capability gate in the JSON must appear in the
 * Rego, so a policy edit that forgets the export cannot land silently.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const findings: string[] = [];

const jsonPath = join(ROOT, "packages", "contracts", "src", "guardrails.json");
const regoPath = join(ROOT, "policies", "guardrails.rego");

if (!existsSync(jsonPath)) findings.push(`missing policy document: ${jsonPath}`);
if (!existsSync(regoPath)) findings.push(`missing Rego export: ${regoPath}`);

if (findings.length === 0) {
  const policy = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    schemaVersion: string;
    defaultDecision: string;
    prohibited: Record<string, string[]>;
    siteAccess: { defaultDenySites: string[] };
    capabilities: Record<
      string,
      {
        grantRequired: boolean;
        consentRequired: boolean;
        siteAccessRequired: boolean;
        allowedActions: string[];
      }
    >;
  };
  const rego = readFileSync(regoPath, "utf8");

  const quoted = (literal: string): boolean => rego.includes(`"${literal}"`);

  if (policy.schemaVersion !== "1")
    findings.push(`unexpected schemaVersion: ${policy.schemaVersion}`);
  if (policy.defaultDecision !== "deny") findings.push("policy defaultDecision is not deny");
  if (!rego.includes('default decision := "deny"')) {
    findings.push("rego export lost its default-deny decision");
  }

  for (const [category, actions] of Object.entries(policy.prohibited)) {
    if (actions.length === 0) findings.push(`prohibited category "${category}" is empty`);
    for (const action of actions) {
      if (!quoted(action)) findings.push(`prohibited action "${action}" missing from Rego export`);
    }
  }
  for (const site of policy.siteAccess.defaultDenySites) {
    if (!quoted(site)) findings.push(`default-deny site "${site}" missing from Rego export`);
  }
  for (const [capability, gates] of Object.entries(policy.capabilities)) {
    if (!quoted(capability)) findings.push(`capability "${capability}" missing from Rego export`);
    for (const action of gates.allowedActions) {
      if (!quoted(action))
        findings.push(`allowed action "${capability}/${action}" missing from Rego export`);
    }
  }
  const gated = Object.entries(policy.capabilities)
    .filter(([, g]) => g.grantRequired)
    .map(([c]) => c);
  for (const capability of gated) {
    if (!rego.includes(capability))
      findings.push(`grant-gated capability "${capability}" missing from Rego export`);
  }
}

if (findings.length === 0) {
  console.log("guardrails: PASS (Rego export in sync with guardrails.json)");
  process.exit(0);
}
console.error(`guardrails: FAIL (${findings.length} finding(s))`);
for (const f of findings.slice(0, 20)) console.error(`  ${f}`);
process.exit(1);
