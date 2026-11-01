import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("Node.js minimum version and upgrade path documentation", () => {
  it("docs/upgrading.md exists and covers required justification and upgrade topics", () => {
    const upgradingPath = join(ROOT, "docs", "upgrading.md");
    expect(existsSync(upgradingPath)).toBe(true);

    const content = readFileSync(upgradingPath, "utf8");
    // Justification features
    expect(content).toContain("node:sqlite");
    expect(content).toMatch(/fetch/i);
    expect(content).toContain("WebSocket");
    // Version managers
    expect(content).toContain(".nvmrc");
    expect(content).toContain("volta");
    // Migration guidance
    expect(content).toContain("Node 20");
    expect(content).toContain("Node 22");
    expect(content).toContain("Node 24");
  });

  it(".nvmrc exists and specifies Node 22", () => {
    const nvmrcPath = join(ROOT, ".nvmrc");
    expect(existsSync(nvmrcPath)).toBe(true);

    const version = readFileSync(nvmrcPath, "utf8").trim();
    expect(version).toMatch(/^22(\.\d+\.\d+)?$/);
  });

  it("package.json pins Node in engines and volta configuration", () => {
    const pkgPath = join(ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      engines?: { node?: string };
      volta?: { node?: string };
    };

    expect(pkg.engines?.node).toBe(">=22");
    expect(pkg.volta?.node).toBeDefined();
    expect(pkg.volta?.node).toMatch(/^22\./);
  });

  it("README.md links to docs/upgrading.md for the Node version requirement", () => {
    const readmePath = join(ROOT, "README.md");
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toMatch(/Requires Node >= 22/);
    expect(readme).toContain("docs/upgrading.md");
  });

  it("CI workflow tests both minimum Node 22 and latest LTS Node 24", () => {
    const ciPath = join(ROOT, ".github", "workflows", "ci.yml");
    expect(existsSync(ciPath)).toBe(true);

    const ciContent = readFileSync(ciPath, "utf8");
    expect(ciContent).toContain("matrix:");
    expect(ciContent).toMatch(/node-version:\s*\[22,\s*24\]/);
    expect(ciContent).toContain("node-version: ${{ matrix.node-version }}");
  });
});
