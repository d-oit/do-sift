/**
 * Degradation-honesty artifact writer (issue #127). Runs the failure-mode
 * suite and records its machine-computed score for the quality gate at
 * evals/degradation/latest.json. The enforcing gate is scripts/eval.ts under
 * `npm run check`; this script refreshes the committed evidence artifact.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDegradationSuite } from "./degradation/run.js";

void runDegradationSuite().then((result) => {
  const artifact = {
    schemaVersion: 1,
    suiteVersion: result.suiteVersion,
    source: "evals/degradation/scenarios.json",
    qualityGate: {
      dimension: "degradationHonesty",
      score: result.degradationHonesty,
      scenariosPassed: result.passed,
      scenariosTotal: result.total,
    },
    scenarios: result.scenarios.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      passed: scenario.passed,
      checks:
        scenario.checks.length -
        scenario.checks.filter((check) => !check.ok).length +
        "/" +
        scenario.checks.length,
    })),
  };
  const dir = join(process.cwd(), "evals", "degradation");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, "latest.json");
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(
    `evals:degradation — ${result.passed}/${result.total} scenarios passed; degradationHonesty=${result.degradationHonesty.toFixed(3)}; artifact ${outputPath}`,
  );
  if (result.degradationHonesty !== 1) {
    for (const scenario of result.scenarios) {
      for (const check of scenario.checks.filter((c) => !c.ok)) {
        console.error(
          `  FAIL ${scenario.id} / ${check.name}: expected ${check.expected}, got ${check.actual}`,
        );
      }
    }
    process.exit(1);
  }
});
