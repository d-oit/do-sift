/**
 * Governance sensor (CLS-07): every sensitive path documented in
 * `docs/github-hardening.md` must have an explicit, owned
 * `.github/CODEOWNERS` rule. Offline only; the online owner-existence check is
 * `GET /repos/{owner}/{repo}/codeowners/errors`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCodeownersCoverage, parseDocumentedPaths } from "./governance/codeowners.js";

const ROOT = process.cwd();
const GUIDE = "docs/github-hardening.md";
const CODEOWNERS = ".github/CODEOWNERS";

function read(relativePath: string): string | undefined {
  try {
    return readFileSync(join(ROOT, relativePath), "utf8");
  } catch {
    console.error(`governance: FAIL — cannot read ${relativePath}`);
    return undefined;
  }
}

const markdown = read(GUIDE);
const codeowners = read(CODEOWNERS);

if (markdown === undefined || codeowners === undefined) {
  process.exit(1);
}

const findings = checkCodeownersCoverage({ markdown, codeowners });

if (findings.length > 0) {
  console.error(`governance: FAIL (${findings.length} finding(s))`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

const covered = parseDocumentedPaths(markdown).length;
console.log(`governance: PASS (${covered} documented sensitive paths covered)`);
