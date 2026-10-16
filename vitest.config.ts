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
    coverage: {
      // #67: runtime source only. Measured 92.5% lines at introduction; the
      // 85% floor catches regressions without failing on today's suite.
      include: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 85 },
    },
  },
});
