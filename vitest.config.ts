import { defineConfig } from "vitest/config";

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
    // Vitest defaults maxWorkers to availableParallelism(); on a 22-core box
    // that means 94 forked workers, and the real-browser test starves next to
    // them (34s for a file that takes 3.5s alone). Bounding the pool keeps the
    // browser test honest instead of timing out on contention.
    maxWorkers: 8,
    coverage: {
      // #67: runtime source only. Measured 92.5% lines at introduction; the
      // 85% floor catches regressions without failing on today's suite.
      include: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 85 },
    },
  },
});
