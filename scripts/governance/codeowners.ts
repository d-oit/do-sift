/**
 * CODEOWNERS coverage (CLS-07).
 *
 * `docs/github-hardening.md` is the single source of truth for which paths are
 * security/policy sensitive; `.github/CODEOWNERS` is what actually requests
 * owner review. This module checks the link between them offline:
 *
 * - every path in the guide's "## Sensitive paths" table has an explicit,
 *   non-wildcard rule with at least one well-formed owner;
 * - a directory rule (`/plans/adr/`) covers its descendants;
 * - a guide with no documented paths fails closed (INV-006 spirit).
 *
 * It cannot verify that an owner handle exists or has write access — GitHub
 * only answers that online (`GET /repos/{owner}/{repo}/codeowners/errors`),
 * which is documented in the guide.
 */

export type CodeownersRule = {
  /** Pattern exactly as written in the file (leading "/" and trailing "/" kept). */
  pattern: string;
  owners: string[];
  /** 1-based line number for actionable failure messages. */
  line: number;
};

export type CoverageInput = {
  markdown: string;
  codeowners: string;
};

const OWNER_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const OWNER_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|?$/u;

/** Normalize a documented path or CODEOWNERS pattern for comparison. */
export function normalizePath(value: string): string {
  return value
    .trim()
    .split("\\")
    .join("/")
    .replace(/^\.\//u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

/**
 * Every backticked path in the guide's "## Sensitive paths" table. A cell may
 * list several paths (`\`do-harness.toml\`, \`.githooks/\``), and tables in
 * other sections are ignored.
 */
export function parseDocumentedPaths(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+Sensitive paths\s*$/iu.test(line.trim()));
  if (start === -1) return [];

  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/u.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || TABLE_SEPARATOR.test(trimmed)) continue;
    const firstCell = trimmed.slice(1).split("|")[0] ?? "";
    for (const match of firstCell.matchAll(/`([^`]+)`/gu)) {
      const path = normalizePath(match[1] ?? "");
      if (path.length > 0) paths.push(path);
    }
  }
  return [...new Set(paths)];
}

/** Parse `.github/CODEOWNERS`: comments and blank lines skipped. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    const [pattern, ...owners] = trimmed.split(/\s+/u);
    if (pattern === undefined) return;
    rules.push({ pattern, owners, line: index + 1 });
  });
  return rules;
}

/**
 * The rule that explicitly covers a documented path, or undefined. The `*`
 * wildcard is deliberately not coverage: the point is that each sensitive path
 * was considered on its own.
 */
export function findCoveringRule(
  rules: readonly CodeownersRule[],
  documentedPath: string,
): CodeownersRule | undefined {
  const target = normalizePath(documentedPath);
  return rules.find((rule) => {
    if (rule.pattern === "*") return false;
    const rulePath = normalizePath(rule.pattern);
    if (rulePath === target) return true;
    return rule.pattern.endsWith("/") && target.startsWith(`${rulePath}/`);
  });
}

/** Findings for the guide ↔ CODEOWNERS link; empty means covered. */
export function checkCodeownersCoverage(input: CoverageInput): string[] {
  const findings: string[] = [];
  const rules = parseCodeowners(input.codeowners);
  const documented = parseDocumentedPaths(input.markdown);

  if (documented.length === 0) {
    findings.push(
      'no documented sensitive paths found — expected a "## Sensitive paths" table in docs/github-hardening.md',
    );
  }

  for (const rule of rules) {
    if (rule.owners.length === 0) {
      findings.push(`.github/CODEOWNERS:${rule.line} pattern "${rule.pattern}" has no owner`);
      continue;
    }
    for (const owner of rule.owners) {
      if (!OWNER_HANDLE.test(owner) && !OWNER_EMAIL.test(owner)) {
        findings.push(
          `.github/CODEOWNERS:${rule.line} invalid owner "${owner}" — expected @handle or email`,
        );
      }
    }
  }

  for (const path of documented) {
    if (findCoveringRule(rules, path) === undefined) {
      findings.push(
        `sensitive path "${path}" has no explicit .github/CODEOWNERS rule (wildcard does not count)`,
      );
    }
  }

  return findings;
}
