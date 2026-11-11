/**
 * Runs the whole test suite: the workspace pool, then the tests/ unit pool.
 *
 * Two configs because tests/** runs with `isolate: false` (its files share no
 * mutable state, so per-file forks were pure overhead) while everything under
 * packages/, scripts/ and apps/ needs a fresh worker each. A vitest `projects`
 * split was tried instead and made the BRW-04 browser e2e time out in teardown
 * — see vitest.unit.config.ts.
 *
 * Sequential on purpose: the pools must not contend, which is the whole point.
 * Exit code is the first failure's, so a sensor receipt goes red either way.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitest)) {
  console.error("tests: FAIL — cannot locate vitest — run npm install");
  process.exit(1);
}

const CONFIGS = ["vitest.config.ts", "vitest.unit.config.ts"];
const extra = process.argv.slice(2);

let failed: string | undefined;
let failedStatus = 1;

for (const config of CONFIGS) {
  const res = spawnSync(
    process.execPath,
    [vitest, "run", "--config", join(ROOT, config), ...extra],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  // Run both pools even if the first fails: a receipt that stops early hides
  // whether the second pool's files still pass.
  if (res.status !== 0 && failed === undefined) {
    failed = config;
    failedStatus = res.status ?? 1;
  }
}

if (failed !== undefined) {
  console.error(`\ntests: FAIL — suite "${failed}" failed`);
  process.exit(failedStatus);
}
