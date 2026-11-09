/**
 * Guardrails Rego export sync (issue #124; plans 039, 041). Pure functions with
 * no fs or process access, so the comparison is unit-testable and identical on
 * every platform. The CLI wrapper is scripts/guardrails-check.ts (the
 * `guardrails` sensor).
 *
 * The Rego data sets are compared with guardrails.json by set equality in both
 * directions, so a value that only appears in a comment, sits in the wrong set,
 * or lingers after the JSON dropped it is a finding. This reads only the data
 * subset the export uses; anything it cannot read is a finding, never a pass.
 */
import type { GuardrailsPolicy } from "@do-sift/contracts";

/** Top-level data assignments parsed from the Rego export. */
export interface RegoData {
  /** `name := {"a", "b"}` and `name := set()`. */
  sets: Map<string, Set<string>>;
  /** `name := {"key": {"a"}}` (one level of sets per key). */
  objects: Map<string, Map<string, Set<string>>>;
  /** Whether `default decision := "deny"` is present. */
  defaultDeny: boolean;
}

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/gu;

/** Normalize CRLF/CR to LF and drop `#` comments outside string literals. */
export function stripRegoComments(rego: string): string {
  return rego
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inString && ch === "\\") {
          i += 1;
        } else if (ch === '"') {
          inString = !inString;
        } else if (ch === "#" && !inString) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

function stringsIn(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].map((m) => m[1] ?? "");
}

/** Index of the brace closing the one at `open` (strings skipped); -1 if unbalanced. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse the top-level data assignments of the export. Rule bodies
 * (`name if { ... }`) and rule-style `name := value if` lines are skipped:
 * only `name := {` and `name := set()` starting at column 0 are read.
 */
export function parseRegoData(rego: string): { data: RegoData; problems: string[] } {
  const text = stripRegoComments(rego);
  const data: RegoData = {
    sets: new Map(),
    objects: new Map(),
    defaultDeny: /^default decision := "deny"[ \t]*$/mu.test(text),
  };
  const problems: string[] = [];
  for (const match of text.matchAll(/^([a-z_][a-z0-9_]*)[ \t]*:=[ \t]*(set\(\)|\{)/gmu)) {
    const name = match[1] ?? "";
    if (match[2] === "set()") {
      data.sets.set(name, new Set());
      continue;
    }
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closingBrace(text, open);
    if (close === -1) {
      problems.push(`${name}: unbalanced braces in the Rego export`);
      continue;
    }
    const body = text.slice(open + 1, close);
    if (!body.includes("{")) {
      data.sets.set(name, new Set(stringsIn(body)));
      continue;
    }
    const entries = new Map<string, Set<string>>();
    for (const entry of body.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*\{([^{}]*)\}/gu)) {
      entries.set(entry[1] ?? "", new Set(stringsIn(entry[2] ?? "")));
    }
    data.objects.set(name, entries);
  }
  return { data, problems };
}

/** Set equality, reported per value in both directions. */
function compareSet(
  name: string,
  expected: Iterable<string>,
  actual: Set<string> | undefined,
  findings: string[],
): void {
  if (actual === undefined) {
    findings.push(`${name}: data set not found in the Rego export`);
    return;
  }
  const want = new Set(expected);
  for (const value of [...want].sort()) {
    if (!actual.has(value)) {
      findings.push(`${name}: "${value}" is in guardrails.json but missing from the Rego export`);
    }
  }
  for (const value of [...actual].sort()) {
    if (!want.has(value)) {
      findings.push(`${name}: "${value}" is in the Rego export but not in guardrails.json`);
    }
  }
}

/** Every way the Rego export disagrees with the policy JSON; empty = in sync. */
export function checkGuardrailsSync(policy: GuardrailsPolicy, rego: string): string[] {
  const { data, problems } = parseRegoData(rego);
  const findings = [...problems];
  if (!data.defaultDeny) {
    findings.push('rego export lost its default-deny decision (default decision := "deny")');
  }

  compareSet(
    "default_deny_sites",
    policy.siteAccess.defaultDenySites,
    data.sets.get("default_deny_sites"),
    findings,
  );

  const prohibitedSets = new Set<string>();
  for (const [category, actions] of Object.entries(policy.prohibited)) {
    if (actions.length === 0) findings.push(`prohibited category "${category}" is empty`);
    const name = `prohibited_${category.split("-").join("_")}`;
    prohibitedSets.add(name);
    compareSet(name, actions, data.sets.get(name), findings);
  }
  for (const name of [...data.sets.keys()].sort()) {
    if (name.startsWith("prohibited_") && !prohibitedSets.has(name)) {
      findings.push(
        `${name}: prohibited set in the Rego export has no category in guardrails.json`,
      );
    }
  }

  const capabilities = Object.entries(policy.capabilities);
  const gated = (gate: "grantRequired" | "consentRequired" | "siteAccessRequired"): string[] =>
    capabilities.filter(([, gates]) => gates[gate]).map(([capability]) => capability);
  compareSet("grant_required", gated("grantRequired"), data.sets.get("grant_required"), findings);
  compareSet(
    "consent_required",
    gated("consentRequired"),
    data.sets.get("consent_required"),
    findings,
  );
  compareSet(
    "site_access_required",
    gated("siteAccessRequired"),
    data.sets.get("site_access_required"),
    findings,
  );
  // The Rego keeps one flat set; the JSON lists scoped actions per capability.
  compareSet(
    "site_scoped_actions",
    capabilities.flatMap(([, gates]) => gates.siteScopedActions),
    data.sets.get("site_scoped_actions"),
    findings,
  );

  const allowed = data.objects.get("allowed_actions");
  if (allowed === undefined) {
    findings.push("allowed_actions: data set not found in the Rego export");
    return findings;
  }
  compareSet(
    "allowed_actions",
    capabilities.map(([capability]) => capability),
    new Set(allowed.keys()),
    findings,
  );
  for (const [capability, gates] of capabilities) {
    const actual = allowed.get(capability);
    if (actual !== undefined) {
      compareSet(`allowed_actions["${capability}"]`, gates.allowedActions, actual, findings);
    }
  }
  return findings;
}
