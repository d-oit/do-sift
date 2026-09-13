/**
 * Validates agent skills (INV-002): frontmatter, name↔directory match,
 * description presence, and that every `npm run X` command exists in the
 * root package.json. Empty skill set is a failure.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const skillsDir = join(ROOT, ".agents", "skills");
const errors: string[] = [];

if (!existsSync(skillsDir)) {
  console.error("skills: FAIL — .agents/skills/ directory missing");
  process.exit(1);
}

const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
if (entries.length === 0) {
  console.error("skills: FAIL — no skills found (INV-006: empty set is a failure)");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = new Set(Object.keys(pkg.scripts ?? {}));

for (const dir of entries) {
  const path = join(skillsDir, dir.name, "SKILL.md");
  if (!existsSync(path)) {
    errors.push(`${dir.name}: SKILL.md missing`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text);
  if (!m || !m[1]) {
    errors.push(`${dir.name}: frontmatter missing`);
    continue;
  }
  const fm = m[1] ?? "";
  const nameMatch = /^name:\s*(.+)$/mu.exec(fm);
  const descMatch = /^description:\s*(.+)$/mu.exec(fm);
  if (!nameMatch || !nameMatch[1]) {
    errors.push(`${dir.name}: frontmatter.name missing`);
  } else if (nameMatch[1].trim() !== dir.name) {
    errors.push(`${dir.name}: frontmatter.name "${nameMatch[1].trim()}" ≠ directory name`);
  }
  if (!descMatch || !descMatch[1] || descMatch[1].trim().length < 20) {
    errors.push(`${dir.name}: description missing or too short`);
  }
  const body = text.slice(m[0].length);
  if (body.trim().length < 200) {
    errors.push(`${dir.name}: body too short to be a usable procedure`);
  }
  for (const cmd of body.matchAll(/npm run ([a-z:0-9-]+)/gu)) {
    const script = cmd[1] ?? "";
    if (!scripts.has(script)) {
      errors.push(`${dir.name}: references unknown npm run "${script}"`);
    }
  }
}

if (errors.length > 0) {
  console.error(`skills: FAIL (${errors.length} error(s))`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`skills: PASS (${entries.length} skills validated)`);
