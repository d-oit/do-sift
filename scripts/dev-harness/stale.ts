/**
 * Status verdicts with staleness (DSH-07, plan 010, set freshness).
 *
 * A green receipt is "stale" when the set fingerprint recorded with it differs
 * from the current working tree — a receipt that does not cover the current tree
 * is not a receipt for the current tree.
 *
 * Schema compatibility contract:
 * - Current receipt schema version is 1.
 * - Valid schema version 1 receipts with matching fingerprints return "green".
 * - Receipts without stored fingerprints (pre-DSH-07) stay green for backward compatibility.
 * - Valid receipts with mismatched fingerprints return "stale".
 * - Malformed receipts, missing receipts, or receipts with unknown schema versions
 *   never pass as green (they yield "red" or "missing").
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SENSOR_DEFS, sensorNamesForSet, resolveSensor, type SensorDef } from "./sensors.js";
import { EvidenceReport, type SensorStatus } from "./schemas.js";

export type StatusVerdict = "green" | "red" | "stale" | "missing";

export interface LastReceipt {
  status: SensorStatus;
  workspaceSha256?: string | undefined;
  schemaVersion?: number | undefined;
}

/**
 * Determine status verdict given the last recorded receipt and the current set fingerprint.
 *
 * Migration/Compatibility Contract:
 * 1. Missing receipt => "missing".
 * 2. Non-pass status => "red".
 * 3. Schema version missing or != 1 => "red" (unknown version fail-safe).
 * 4. Stored fingerprint mismatched => "stale".
 * 5. Matching or unjudgeable (pre-fingerprint) fingerprint on pass receipt => "green".
 */
export function statusVerdict(
  last: LastReceipt | undefined,
  currentFingerprint: string | undefined,
): StatusVerdict {
  if (last === undefined) return "missing";
  if (last.status !== "pass") return "red";
  if (last.schemaVersion !== undefined && last.schemaVersion !== 1) return "red";

  const { workspaceSha256 } = last;
  if (
    workspaceSha256 !== undefined &&
    currentFingerprint !== undefined &&
    workspaceSha256 !== currentFingerprint
  ) {
    return "stale";
  }
  return "green";
}

/** Excluded directory patterns for workspace fingerprinting. */
const EXCLUDED_DIRS = new Set([
  ".do-harness",
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  ".fastembed_cache",
  ".hf-cache",
  ".spikes",
]);

/**
 * Check whether a relative file path is a relevant input for a given sensor name.
 */
export function isSensorInput(sensorName: string, relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  if (norm.startsWith(".do-harness/") || norm === ".do-harness") return false;

  switch (sensorName) {
    case "format": {
      if (
        norm === ".prettierrc.json" ||
        norm === ".prettierignore" ||
        norm === ".gitignore" ||
        norm === "package.json"
      ) {
        return true;
      }
      // Exclude set-specific subtrees/files that have dedicated sensors
      if (
        norm.startsWith("evals/") ||
        norm.startsWith("migrations/") ||
        norm.startsWith(".agents/skills/")
      ) {
        return false;
      }
      return /\.(?:[tj]sx?|mjs|cjs|json|md|ya?ml|css|scss|html)$/u.test(norm);
    }
    case "lint": {
      if (norm === "eslint.config.mjs" || norm === ".gitignore" || norm === "package.json") {
        return true;
      }
      if (
        norm.startsWith("evals/") ||
        norm.startsWith("migrations/") ||
        norm.startsWith(".agents/skills/")
      ) {
        return false;
      }
      return /\.(?:[tj]sx?|mjs|cjs)$/u.test(norm);
    }
    case "build":
    case "typecheck": {
      if (
        norm === "tsconfig.json" ||
        norm === "tsconfig.base.json" ||
        norm === "tsconfig.build.json" ||
        norm === "package.json" ||
        norm === "package-lock.json"
      ) {
        return true;
      }
      if (
        norm.startsWith("evals/") ||
        norm.startsWith("migrations/") ||
        norm.startsWith(".agents/skills/")
      ) {
        return false;
      }
      return /\.(?:[tj]sx?|mjs|cjs)$/u.test(norm);
    }
    case "policy": {
      return (
        norm === "scripts/policy.ts" ||
        norm === "plans/invariants.json" ||
        norm === "AGENTS.md" ||
        norm === "package.json" ||
        norm === "package-lock.json"
      );
    }
    case "skills": {
      return norm === "scripts/skills-check.ts" || norm.startsWith(".agents/skills/");
    }
    case "governance": {
      return (
        norm === "docs/github-hardening.md" ||
        norm === ".github/CODEOWNERS" ||
        norm === "scripts/codeowners-check.ts" ||
        norm.startsWith("scripts/governance/") ||
        norm === "scripts/check.ts" ||
        norm === "package.json"
      );
    }
    case "tests": {
      if (norm === "vitest.config.ts" || norm === "package.json" || norm === "package-lock.json") {
        return true;
      }
      return (
        /\.(?:test|spec)\.[tj]sx?$/u.test(norm) ||
        norm.startsWith("tests/") ||
        norm.includes("/test/")
      );
    }
    case "evals": {
      return norm === "scripts/eval.ts" || norm.startsWith("evals/");
    }
    case "release": {
      return (
        norm === "scripts/release-check.ts" ||
        norm === "CHANGELOG.md" ||
        norm === "README.md" ||
        norm.startsWith("migrations/") ||
        norm === "package.json" ||
        norm === "package-lock.json"
      );
    }
    default: {
      return true;
    }
  }
}

function getGitFileList(repoRoot: string): string[] | undefined {
  const resTracked = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  const resOthers = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (resTracked.status !== 0 || resOthers.status !== 0) return undefined;
  const tracked = resTracked.stdout ? resTracked.stdout.split("\0") : [];
  const others = resOthers.stdout ? resOthers.stdout.split("\0") : [];
  return [...tracked, ...others].filter((p) => p.length > 0);
}

function scanFilesRecursively(dir: string, baseDir: string, results: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      scanFilesRecursively(full, baseDir, results);
    } else if (st.isFile()) {
      const rel = relative(baseDir, full).split("\\").join("/");
      results.push(rel);
    }
  }
}

/**
 * Calculate a deterministic set fingerprint for a given signal set.
 *
 * Factors in:
 * - Schema version (1) and signal set name
 * - Sensor identities (names and arguments)
 * - Relevant input file content (sorted path order, normalized LF line endings)
 * Excludes generated outputs like `.do-harness/`.
 */
export function computeSetFingerprint(
  setName: string,
  repoRoot: string,
  registry: readonly SensorDef[] = SENSOR_DEFS,
): string | undefined {
  let names: string[];
  try {
    names = sensorNamesForSet(setName, registry);
  } catch {
    return undefined;
  }

  const sensorDefs = names.map((n) => resolveSensor(n, registry));
  let candidateFiles = getGitFileList(repoRoot);
  if (candidateFiles === undefined) {
    const list: string[] = [];
    scanFilesRecursively(repoRoot, repoRoot, list);
    candidateFiles = list;
  }

  // Filter candidates relevant to at least one sensor in the set
  const relevantFiles = new Set<string>();
  for (const relPath of candidateFiles) {
    const posixPath = relPath.split("\\").join("/");
    if (sensorDefs.some((def) => isSensorInput(def.name, posixPath))) {
      relevantFiles.add(posixPath);
    }
  }

  const sortedPaths = [...relevantFiles].sort();
  const hash = createHash("sha256");

  // Include set definition metadata
  hash.update(`schemaVersion:1\0set:${setName}\0`);
  for (const def of sensorDefs) {
    hash.update(`sensor:${def.name}\0args:${def.args.join(" ")}\0`);
  }

  // Include relevant file contents
  for (const relPath of sortedPaths) {
    hash.update(`${relPath}\0`);
    try {
      const content = readFileSync(join(repoRoot, relPath), "utf8");
      const normalized = content.replace(/\r\n/g, "\n");
      hash.update(normalized);
    } catch {
      hash.update("missing");
    }
  }

  return hash.digest("hex");
}

/**
 * Validate an EvidenceReport file if present.
 * Returns EvidenceReport or undefined if missing/invalid/unknown version.
 */
export function parseEvidenceReceipt(filePath: string): EvidenceReport | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    const parsed = EvidenceReport.safeParse(json);
    if (!parsed.success) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}
