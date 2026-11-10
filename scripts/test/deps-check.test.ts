/**
 * deps sensor tests (plan 044, DRV-07). The sensor is pure over a lockfile
 * object plus a manifests list, so every branch is provable without touching
 * the network or the real lockfile.
 */
import { describe, expect, it } from "vitest";
import {
  checkDependencies,
  packageNameFromKey,
  workspaceManifests,
  type Lockfile,
} from "../deps-check.js";

const DIR = "/repo";
const MANIFESTS = ["/repo/package.json", "/repo/packages/a/package.json"];
const NO_OVERRIDES: Record<string, string> = {};
/** Default to no documented blocks so synthetic locks stay independent. */
const NO_KNOWN: ReadonlyArray<{ name: string; reason: string }> = [];

function lock(packages: Record<string, { version?: string; deprecated?: unknown }>): Lockfile {
  return { lockfileVersion: 3, packages: { "": {}, ...packages } };
}

const kinds = (findings: Array<{ kind: string }>): string[] => findings.map((f) => f.kind);

/** A lockfile with no deprecated packages, so baseline findings stay empty. */
const CLEAN = lock({
  "node_modules/left-pad": { version: "1.0.0" },
  "packages/a": { version: "0.1.0" },
});

describe("packageNameFromKey", () => {
  it("strips the nested node_modules prefix", () => {
    expect(packageNameFromKey("node_modules/minimatch")).toBe("minimatch");
    expect(packageNameFromKey("node_modules/a/node_modules/@scope/pkg")).toBe("@scope/pkg");
    expect(packageNameFromKey("packages/a")).toBe("packages/a");
  });
});

describe("workspaceManifests", () => {
  it("finds the root plus workspace manifests in this repo", () => {
    const found = workspaceManifests(process.cwd());
    expect(found.some((p) => p.endsWith("package.json"))).toBe(true);
    expect(found.length).toBeGreaterThan(10);
  });
});

describe("checkDependencies", () => {
  it("passes a clean tree", () => {
    const result = checkDependencies(DIR, CLEAN, MANIFESTS, NO_OVERRIDES, NO_KNOWN);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(2);
  });

  it("fails on a deprecated package", () => {
    const result = checkDependencies(
      DIR,
      lock({
        "packages/a": { version: "0.1.0" },
        "node_modules/old-thing": { version: "2.0.0", deprecated: "no longer supported" },
      }),
      MANIFESTS,
      NO_OVERRIDES,
      NO_KNOWN,
    );
    expect(kinds(result.findings)).toEqual(["deprecated"]);
    expect(result.findings[0]?.detail).toContain("old-thing@2.0.0");
  });

  it("tolerates the documented upstream blocks", () => {
    const result = checkDependencies(
      DIR,
      lock({
        "packages/a": { version: "0.1.0" },
        "node_modules/boolean": { version: "3.2.0", deprecated: "no longer supported" },
        "node_modules/@anush008/tokenizers": { version: "0.0.0", deprecated: "archived" },
      }),
      MANIFESTS,
      NO_OVERRIDES,
    );
    expect(result.findings).toEqual([]);
  });

  it("fails when a documented block has been removed upstream", () => {
    const result = checkDependencies(DIR, CLEAN, MANIFESTS, NO_OVERRIDES, [
      { name: "boolean", reason: "test" },
    ]);
    const stale = result.findings.filter((f) => f.kind === "stale-known-deprecated");
    expect(stale.length).toBe(1);
    expect(stale[0]?.detail).toContain("boolean");
  });

  it("does not report staleness for a block still present", () => {
    const result = checkDependencies(
      DIR,
      lock({
        "packages/a": { version: "0.1.0" },
        "node_modules/boolean": { version: "3.2.0", deprecated: "unsupported" },
      }),
      MANIFESTS,
      NO_OVERRIDES,
      [{ name: "boolean", reason: "test" }],
    );
    expect(result.findings).toEqual([]);
  });

  it("fails when a workspace manifest has no lockfile entry", () => {
    const result = checkDependencies(DIR, lock({}), MANIFESTS, NO_OVERRIDES);
    expect(kinds(result.findings)).toContain("unresolved-workspace");
  });

  it("fails on a vacuous scan (INV-006)", () => {
    const result = checkDependencies(
      DIR,
      { lockfileVersion: 3, packages: { "": {} } },
      MANIFESTS,
      NO_OVERRIDES,
    );
    expect(kinds(result.findings)).toContain("no-resolved-packages");
  });

  it("fails when no manifests are discovered", () => {
    const result = checkDependencies(
      DIR,
      lock({ "packages/a": { version: "0.1.0" } }),
      [],
      NO_OVERRIDES,
    );
    expect(kinds(result.findings)).toContain("no-manifests");
  });

  it("passes an override that still resolves to one version", () => {
    const result = checkDependencies(
      DIR,
      lock({
        "packages/a": { version: "0.1.0" },
        "node_modules/minimatch": { version: "11.0.5" },
      }),
      MANIFESTS,
      { minimatch: "^11.0.5" },
      NO_KNOWN,
    );
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("minimatch");
  });

  it("fails on an inert override that matches nothing", () => {
    const result = checkDependencies(DIR, CLEAN, MANIFESTS, { minimatch: "^11.0.5" }, NO_KNOWN);
    expect(kinds(result.findings)).toContain("inert-override");
  });

  it("fails when an override leaves two versions resolved", () => {
    const result = checkDependencies(
      DIR,
      lock({
        "packages/a": { version: "0.1.0" },
        "node_modules/minimatch": { version: "11.0.5" },
        "node_modules/eslint/node_modules/minimatch": { version: "10.2.6" },
      }),
      MANIFESTS,
      { minimatch: "^11.0.5" },
    );
    expect(kinds(result.findings)).toContain("overridden-multiple");
  });
});
