/**
 * Shared helpers for the dev-harness CLI test shards (cli.usage / cli.state /
 * cli.staleness). The CLI tests spawn the real CLI through tsx
 * (`node node_modules/tsx/dist/cli.mjs scripts/dev-harness/cli.ts`, the same
 * invocation npm run signals and the git hooks use) with a fresh os.tmpdir()
 * --state-dir per test.
 *
 * They were one 14-test file, and each test pays a ~680ms cold tsx start, so
 * the file alone was ~two thirds of scripts/ wall time (plan 008 set a < 10 s
 * budget for it). Sharding lets vitest run the groups in parallel under the
 * bounded worker pool; nothing about what is spawned or asserted changed.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// The CLI tests spawn real node+tsx processes; under full-suite parallel
// load on Windows a cold spawn can exceed the 5s default (observed once:
// `list` timed out at 5000ms in a verification-set run). 30s headroom —
// every assertion stays unchanged.
vi.setConfig({ testTimeout: 30_000 });

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY = join(REPO_ROOT, "scripts", "dev-harness", "cli.ts");

const dirs: string[] = [];

export async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "do-sift-cli-"));
  dirs.push(dir);
  return dir;
}

/** Register with `afterEach(cleanupStateDirs)` in every shard that uses makeStateDir. */
export async function cleanupStateDirs(): Promise<void> {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
}

export function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}
