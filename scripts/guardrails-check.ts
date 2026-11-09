/**
 * Guardrails Rego export sync gate (issue #124; plans 039, 040, 041) — the
 * `guardrails` step of `npm run check` and dev-signal sensor.
 *
 * `policies/guardrails.rego` is an auditable OPA-readable export of the
 * shipped policy; `packages/contracts/src/guardrails.json` is the single
 * source of truth and the TypeScript evaluator is what the kernel executes
 * (Node-only pipeline, ADR 0001). The comparison lives in
 * `scripts/guardrails/sync.ts`; this wrapper only reads the two files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GuardrailsPolicy } from "@do-sift/contracts";
import { checkGuardrailsSync } from "./guardrails/sync.js";

const ROOT = process.cwd();
const jsonPath = join(ROOT, "packages", "contracts", "src", "guardrails.json");
const regoPath = join(ROOT, "policies", "guardrails.rego");

function run(): string[] {
  const missing: string[] = [];
  if (!existsSync(jsonPath)) missing.push(`missing policy document: ${jsonPath}`);
  if (!existsSync(regoPath)) missing.push(`missing Rego export: ${regoPath}`);
  if (missing.length > 0) return missing;
  const parsed = GuardrailsPolicy.safeParse(JSON.parse(readFileSync(jsonPath, "utf8")));
  if (!parsed.success) {
    return [`guardrails.json does not match the GuardrailsPolicy schema: ${parsed.error.message}`];
  }
  return checkGuardrailsSync(parsed.data, readFileSync(regoPath, "utf8"));
}

const findings = run();
if (findings.length === 0) {
  console.log("guardrails: PASS (Rego export in sync with guardrails.json)");
  process.exit(0);
}
console.error(`guardrails: FAIL (${findings.length} finding(s))`);
for (const f of findings.slice(0, 20)) console.error(`  ${f}`);
process.exit(1);
