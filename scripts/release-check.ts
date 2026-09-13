/**
 * Release candidate validation (see prepare-release skill). Validates only;
 * never builds with publishing credentials and never publishes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const errors: string[] = [];

function git(args: string[]): string {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) return "";
  return (res.stdout ?? "").trim();
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
const version = pkg.version ?? "";
if (!/^\d+\.\d+\.\d+/.test(version)) errors.push(`package.json version invalid: "${version}"`);

const changelogPath = join(ROOT, "CHANGELOG.md");
if (!existsSync(changelogPath)) {
  errors.push("CHANGELOG.md missing");
} else {
  const changelog = readFileSync(changelogPath, "utf8");
  if (!changelog.includes(`## [${version}]`)) {
    errors.push(`CHANGELOG.md has no entry for ${version}`);
  }
}

// migrations, if present, must be numbered and monotonic
const migrationsDir = join(ROOT, "migrations");
if (existsSync(migrationsDir)) {
  const nums = readdirNums(migrationsDir);
  for (let i = 1; i < nums.length; i++) {
    if ((nums[i] ?? 0) !== (nums[i - 1] ?? 0) + 1) {
      errors.push(`migrations not monotonic at index ${i}: ${nums.join(",")}`);
    }
  }
}

function readdirNums(dir: string): number[] {
  return readdirSync(dir)
    .map((f) => Number.parseInt(f.slice(0, 4), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

const tag = `v${version}`;
const existingTag = git(["tag", "-l", tag]);
if (existingTag === tag) errors.push(`tag ${tag} already exists`);

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const commit = git(["rev-parse", "HEAD"]);
if (!commit) errors.push("not a git repository or no commits");

if (errors.length === 0) {
  console.log(`release-check: PASS — candidate ${tag} @ ${commit.slice(0, 12)} (branch ${branch})`);
  console.log("publishing remains a separate approval-gated step (AGENTS.md)");
  process.exit(0);
}
console.error(`release-check: FAIL (${errors.length})`);
for (const e of errors) console.error(`  ${e}`);
process.exit(1);
