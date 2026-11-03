/**
 * Documentation link integrity sensor (issue #121, INV-009).
 *
 * Walks the maintained documentation surface, checks every relative link and
 * anchor, and fails with actionable `file:line` findings. Zero files scanned
 * is a failure (INV-006: a vacuous pass is not a pass).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkLinks, headingAnchors, relativeLinks } from "./docs/links.js";
const ROOT = process.cwd();

/** Directories whose Markdown is part of the documentation surface. */
const SCAN_ROOTS = ["docs", "plans", ".agents", "packages"];
/** Root-level documents plus the agent-facing plain-text index. */
const ROOT_FILES = ["README.md", "CONTRIBUTING.md", "CHANGELOG.md", "AGENTS.md", "llms.txt"];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      walk(path, out);
      continue;
    }
    if (entry.endsWith(".md") || entry.endsWith(".txt")) out.push(path);
  }
}

function repoRelative(path: string): string {
  return relative(ROOT, path).split(sep).join("/");
}

const files = new Map<string, string>();
for (const dir of SCAN_ROOTS) {
  const found: string[] = [];
  walk(join(ROOT, dir), found);
  for (const path of found) {
    files.set(repoRelative(path), readFileSync(path, "utf8"));
  }
}
for (const name of ROOT_FILES) {
  try {
    files.set(name, readFileSync(join(ROOT, name), "utf8"));
  } catch {
    // A missing root document is caught by the zero-scan gate below.
  }
}

const scan = [...files.keys()].sort();
if (scan.length === 0) {
  console.error("links: FAIL — zero Markdown files scanned (INV-006: empty set is a failure)");
  process.exit(1);
}

const findings = checkLinks({
  files,
  scan,
  exists: (path) => existsSync(join(ROOT, path)),
});

// A scanner whose matcher silently stops matching would report zero findings
// and look green. A small set of "anchor" documents must each contain at
// least one relative link, and the total must be non-trivial.
const REQUIRED_LINK_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "plans/README.md",
  "docs/architecture/README.md",
  "docs/decisions/README.md",
];

let anchorCount = 0;
for (const path of scan) {
  anchorCount += headingAnchors(files.get(path) ?? "").size;
}

const linkCount = scan.reduce(
  (total, path) => total + relativeLinks(files.get(path) ?? "").length,
  0,
);
if (linkCount === 0) {
  console.error("links: FAIL — no relative links found across the documentation surface");
  process.exit(1);
}
if (anchorCount === 0) {
  console.error("links: FAIL — no headings found across the documentation surface");
  process.exit(1);
}

const missingAnchors = REQUIRED_LINK_FILES.filter(
  (path) => !files.has(path) || relativeLinks(files.get(path) ?? "").length === 0,
);
if (missingAnchors.length > 0) {
  console.error(
    `links: FAIL — ${missingAnchors.length} index document(s) missing or contain no relative links`,
  );
  for (const path of missingAnchors) console.error(`  ${path}`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`links: FAIL (${findings.length} broken link(s) in ${scan.length} files)`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} ${finding.target} — ${finding.reason}`);
  }
  process.exit(1);
}

console.log(`links: PASS (${scan.length} files, ${linkCount} links, ${anchorCount} headings)`);
