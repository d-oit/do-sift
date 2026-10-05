/**
 * QF-02: eval runner failure-path contract. When the local embedding model
 * cannot be prepared (e.g. a poisoned cache archive from a failed download),
 * the runner must still print its PASS/FAIL summary and exit 0/1 — never die
 * with an unhandled rejection that loses the earlier stages' report. The
 * poisoned archive must not survive the run as-is (cleaned or replaced by a
 * genuine re-download). Works in both offline (clean FAIL) and online
 * (recover + PASS) environments; it asserts the contract, not the outcome.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const execFileAsync = promisify(execFile);

const MARKER = "POISONED-MARKER-QF02";

interface RunResult {
  code: number | string;
  stdout: string;
  stderr: string;
}

async function runEval(cacheDir: string): Promise<RunResult> {
  const env = { ...process.env, DO_SIFT_EVAL_MODEL_CACHE: cacheDir };
  try {
    const r = await execFileAsync(process.execPath, [TSX_CLI, join(ROOT, "scripts", "eval.ts")], {
      cwd: ROOT,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("eval runner failure path (QF-02)", () => {
  it(
    "poisoned model cache → clean PASS/FAIL report, bounded exit code, marker removed",
    { timeout: 300_000 },
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "qf02-eval-cache-"));
      const archive = join(cacheDir, "fast-bge-small-en-v1.5.tar.gz");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(archive, MARKER);

      const res = await runEval(cacheDir);
      const out = res.stdout + res.stderr;

      // Bounded exit: a report, not a crash.
      expect([0, 1]).toContain(res.code);
      expect(out).toMatch(/eval: (PASS|FAIL)/);
      // No unhandled-rejection stack dump (tar internals leaking to the user).
      expect(out).not.toMatch(/warn-mixin|at Unpack|unhandledrejection/i);

      // The poisoned artifact must not survive as-is.
      const markerSurvives = existsSync(archive) && readFileSync(archive, "utf8").includes(MARKER);
      expect(markerSurvives).toBe(false);
    },
  );
});
