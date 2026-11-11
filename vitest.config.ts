import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

/**
 * Worker-pool size, derived rather than pinned.
 *
 * Vitest's default is availableParallelism(), which forks one worker per test
 * file (94 here). The real-browser e2e then starves next to them: 34s for a
 * file that takes 3.5s alone, and its hook hits the ceiling. Half the cores
 * keeps the browser test honest on a big machine; the floor keeps small CI
 * runners from serialising the suite one file at a time.
 */
const CPU_COUNT = Math.max(1, availableParallelism());
const MAX_WORKERS = CPU_COUNT <= 4 ? CPU_COUNT : Math.min(8, Math.ceil(CPU_COUNT / 2));

export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "scripts/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    // Real-browser and git-spawning tests (BRW-04 e2e, set-isolation) exceed
    // vitest's 5s defaults when ~93 workers run in parallel on Windows. The
    // e2e now genuinely launches chromium rather than silently skipping, so
    // the budget must cover a browser start/stop, not a no-op.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Vitest defaults maxWorkers to availableParallelism(), which on a 22-core
    // box means 94 forked workers; see MAX_WORKERS above for the derivation.
    maxWorkers: MAX_WORKERS,
    coverage: {
      // #67: runtime source only. Measured 92.5% lines at introduction; the
      // 85% floor catches regressions without failing on today's suite.
      include: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 85 },
    },
  },
});
