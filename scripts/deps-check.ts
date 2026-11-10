/**
 * Dependency freshness sensor (plan 044, DRV-07).
 *
 * Deterministic and **network-free** (INV-006): it reads `package-lock.json`
 * only. Registry data expires, so "is a newer version published" is the
 * weekly review's job (`plans/044`); what belongs in the gate is the part
 * that can be judged offline and would otherwise rot silently:
 *
 * 1. every workspace manifest resolves in the lockfile;
 * 2. no resolved package is flagged deprecated — except the documented
 *    upstream blocks (see KNOWN_DEPRECATED);
 * 3. every `overrides` entry still matches exactly one resolved version, so
 *    a dead override cannot linger.
 *
 * Zero manifests or zero resolved packages is a failure, never a pass
 * (INV-006: a vacuous pass is not a pass).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

export type LockEntry = {
  version?: string;
  deprecated?: unknown;
  dev?: boolean;
};

export type Lockfile = {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
};

/**
 * Deprecations we cannot fix from inside this repo. Each needs a reason and a
 * tracking reference; the sensor fails if the entry disappears, so the note
 * cannot outlive the problem.
 */
const KNOWN_DEPRECATED: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "boolean",
    reason:
      "via onnxruntime-node@1.21.0 → global-agent/roarr; fastembed pins onnxruntime-node " +
      "exactly, so only a fastembed release clears it (plan 044 DRV-06)",
  },
  {
    name: "@anush008/tokenizers",
    reason:
      "archived upstream, replaced by @huggingface/tokenizers; fastembed still depends on it " +
      "(plan 044 DRV-06)",
  },
];

/** Manifests that declare dependencies (root + workspaces). */
export function workspaceManifests(dir: string): string[] {
  const out: string[] = [join(dir, "package.json")];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const path = join(current, entry);
      let isDir = false;
      try {
        isDir = readdirSync(path).length >= 0;
      } catch {
        isDir = false;
      }
      if (isDir) {
        walk(path);
        continue;
      }
      if (entry === "package.json" && path !== out[0]) out.push(path);
    }
  };
  for (const sub of ["packages", "apps"]) walk(join(dir, sub));
  return out;
}

/** Repo-relative, forward slashes, no leading `./`. */
function rel(dir: string, path: string): string {
  return relative(dir, path).split(sep).join("/");
}

export type Finding = { kind: string; detail: string };

/** Package name from a lockfile `node_modules/...` key. */
export function packageNameFromKey(key: string): string {
  const idx = key.lastIndexOf("node_modules/");
  return idx < 0 ? key : key.slice(idx + "node_modules/".length);
}

export function checkDependencies(
  dir: string,
  lock: Lockfile,
  manifests: readonly string[],
  overrides: Record<string, string>,
  knownDeprecated: ReadonlyArray<{ name: string; reason: string }> = KNOWN_DEPRECATED,
): { findings: Finding[]; scanned: number; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const packages = lock.packages ?? {};

  if (manifests.length === 0) {
    findings.push({ kind: "no-manifests", detail: "no package.json files discovered" });
  }

  // 1. Every workspace manifest must be represented in the lockfile.
  for (const manifest of manifests) {
    const key = rel(dir, manifest).replace(/\/package\.json$/, "");
    const lockKey = key === "package.json" ? "" : key;
    if (lockKey !== "" && packages[lockKey] === undefined) {
      findings.push({
        kind: "unresolved-workspace",
        detail: `${rel(dir, manifest)} has no lockfile entry (${lockKey || "."})`,
      });
    }
  }

  // 2. Deprecations, minus the documented upstream blocks.
  const known = new Set(knownDeprecated.map((k) => k.name));
  const seenKnown = new Set<string>();

  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") continue;
    if (entry.deprecated === undefined || entry.deprecated === false) continue;
    const name = packageNameFromKey(key);
    const where = `${name}@${entry.version ?? "?"}`;
    if (known.has(name)) {
      seenKnown.add(name);
      continue;
    }
    const text = typeof entry.deprecated === "string" ? `: ${entry.deprecated}` : "";
    findings.push({ kind: "deprecated", detail: `${where}${text}` });
  }

  // A documented block that is no longer present means the note is stale.
  for (const { name } of knownDeprecated) {
    if (seenKnown.has(name)) continue;
    const stillThere = Object.keys(packages).some(
      (key) => key !== "" && packageNameFromKey(key) === name,
    );
    if (!stillThere) {
      findings.push({
        kind: "stale-known-deprecated",
        detail: `${name} is gone from the lockfile; drop its KNOWN_DEPRECATED entry`,
      });
    }
  }

  // 3. Each override must still match exactly one resolved version.
  for (const [name, spec] of Object.entries(overrides)) {
    const resolved = Object.entries(packages)
      .filter(([key]) => key !== "" && packageNameFromKey(key) === name)
      .map(([, entry]) => entry.version)
      .filter((v): v is string => typeof v === "string");
    if (resolved.length === 0) {
      findings.push({
        kind: "inert-override",
        detail: `overrides["${name}"] (${spec}) matches no resolved package; remove it`,
      });
      continue;
    }
    const unique = new Set(resolved);
    if (unique.size > 1) {
      findings.push({
        kind: "overridden-multiple",
        detail: `overrides["${name}"] (${spec}) but ${unique.size} versions resolve: ${[...unique].join(", ")}`,
      });
      continue;
    }
    // Satisfying the declared range is npm's job; the sensor only proves the
    // override still bites something, so a stale entry cannot linger.
    notes.push(`overrides["${name}"] ${spec} → ${[...unique][0] ?? "?"}`);
  }

  const scanned = Object.keys(packages).filter((k) => k !== "").length;
  if (scanned === 0) {
    findings.push({
      kind: "no-resolved-packages",
      detail: "lockfile resolved zero packages (INV-006: empty set is a failure)",
    });
  }

  return { findings, scanned, notes };
}

/* CLI entrypoint: only when this file is run directly, so the module stays
 * importable by tests without executing checks or writing to stdout. */
const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("deps-check.ts") || process.argv[1].endsWith("deps-check.js"));

function main(): void {
  const lockPath = join(ROOT, "package-lock.json");
  if (!existsSync(lockPath)) {
    console.error("deps: FAIL — package-lock.json not found (run npm install)");
    process.exit(1);
  }

  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Lockfile;
  const manifests = workspaceManifests(ROOT);

  let overrides: Record<string, string> = {};
  try {
    const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      overrides?: Record<string, string>;
    };
    overrides = rootPkg.overrides ?? {};
  } catch {
    console.error("deps: FAIL — cannot read the root package.json");
    process.exit(1);
  }

  const { findings, scanned } = checkDependencies(ROOT, lock, manifests, overrides);

  if (findings.length > 0) {
    console.error(`deps: FAIL (${findings.length} finding(s) across ${scanned} resolved packages)`);
    for (const finding of findings) console.error(`  [${finding.kind}] ${finding.detail}`);
    process.exit(1);
  }

  const workspaces = manifests.filter((p) => p !== join(ROOT, "package.json")).length;
  console.log(
    `deps: PASS (${scanned} resolved packages, ${workspaces} workspace manifests, ` +
      `${KNOWN_DEPRECATED.length} documented upstream blocks, ${Object.keys(overrides).length} override(s))`,
  );
}

if (isEntrypoint) main();
