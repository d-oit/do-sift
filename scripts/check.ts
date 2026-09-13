/**
 * do-sift check orchestrator (FND-04).
 * Runs an explicit command list via node + resolved JS entrypoints — no
 * shell interpolation, per-step timeouts, clear report. Zero registered
 * checks is a failure (INV-006).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FAST = process.argv.includes("--fast");

interface Step {
  name: string;
  args: string[];
  fast: boolean;
}

function pkgEntry(pkg: string, sub: string): string {
  const p = join(ROOT, "node_modules", pkg, sub);
  if (!existsSync(p)) throw new Error(`cannot locate ${pkg}/${sub} — run npm install`);
  return p;
}

const tsxCli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
if (!existsSync(tsxCli)) throw new Error("cannot locate tsx CLI — run npm install");

const steps: Step[] = [
  {
    name: "prettier",
    args: [pkgEntry("prettier", "bin/prettier.cjs"), "--check", "."],
    fast: true,
  },
  { name: "eslint", args: [pkgEntry("eslint", "bin/eslint.js"), "."], fast: true },
  {
    name: "typecheck",
    args: [pkgEntry("typescript", "bin/tsc"), "-p", join(ROOT, "tsconfig.json"), "--noEmit"],
    fast: true,
  },
  { name: "policy", args: [tsxCli, "scripts/policy.ts"], fast: true },
  { name: "skills", args: [tsxCli, "scripts/skills-check.ts"], fast: true },
  { name: "tests", args: [pkgEntry("vitest", "vitest.mjs"), "run"], fast: false },
  { name: "evals", args: [tsxCli, "scripts/eval.ts"], fast: false },
];

const selected = steps.filter((s) => (FAST ? s.fast : true));
if (selected.length === 0) {
  console.error("check: FAIL — zero checks registered (INV-006)");
  process.exit(1);
}

const results: Array<{ name: string; ok: boolean; ms: number }> = [];
let failed = false;

for (const step of selected) {
  const start = Date.now();
  const res = spawnSync(process.execPath, step.args, {
    cwd: ROOT,
    timeout: 300_000,
    encoding: "utf8",
  });
  const ms = Date.now() - start;
  const ok = res.status === 0;
  results.push({ name: step.name, ok, ms });
  if (!ok) {
    failed = true;
    console.error(`\n── ${step.name} FAILED (${ms}ms) ──`);
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  } else {
    console.log(`✓ ${step.name} (${ms}ms)`);
  }
}

console.log("\ncheck report:");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ms}ms`);
console.log(`mode: ${FAST ? "fast" : "full"}; steps: ${results.length}`);
process.exit(failed ? 1 : 0);
