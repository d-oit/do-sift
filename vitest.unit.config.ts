import { defineConfig } from "vitest/config";
import { DEFAULT_TIMEOUT_MS, MAX_WORKERS } from "./vitest.shared.js";

/**
 * Unit/security suite: `tests/**`, run with `isolate: false`.
 *
 * These files assert over in-process state — no database, server, temp dir or
 * browser — so a fresh worker per file bought isolation they never used and
 * cost ~800ms of fork startup each (15 files ≈ 6s of pure overhead).
 *
 * This is a separate config rather than a vitest `projects` entry on purpose:
 * a projects split changes worker scheduling, and the BRW-04 browser e2e then
 * times out in teardown (measured 3 failures in 4 runs, against 0 in 4 on the
 * single-project config). A separate command keeps the two pools independent.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: DEFAULT_TIMEOUT_MS,
    hookTimeout: DEFAULT_TIMEOUT_MS,
    maxWorkers: MAX_WORKERS,
    // Safe here precisely because nothing in tests/ shares mutable global
    // state: no listen ports, no temp directories, no browser handles.
    isolate: false,
  },
});
