import { defineConfig } from "vitest/config";
import { DEFAULT_TIMEOUT_MS, MAX_WORKERS } from "./vitest.shared.js";

/**
 * Workspace pool: packages/, scripts/ and apps/.
 *
 * `tests/**` is deliberately absent — it runs from vitest.unit.config.ts with
 * `isolate: false`. Listing it here as well would run every file twice.
 */
export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "scripts/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: DEFAULT_TIMEOUT_MS,
    hookTimeout: DEFAULT_TIMEOUT_MS,
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
