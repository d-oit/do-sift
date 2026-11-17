import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkVersionPolicy, parseCiNodeMatrix, parseFloor } from "../version-policy.js";

const ROOT = process.cwd();
function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function repoInputs() {
  const pkg = JSON.parse(read("package.json")) as {
    engines?: { node?: string };
    volta?: { node?: string };
  };
  return {
    engines: pkg.engines?.node,
    voltaNode: pkg.volta?.node,
    nvmrc: read(".nvmrc"),
    dockerfile: read("Dockerfile"),
    ciYml: read(".github/workflows/ci.yml"),
    readme: read("README.md"),
    upgrading: read("docs/upgrading.md"),
  };
}

describe("version policy", () => {
  it("parses floors and CI matrices", () => {
    expect(parseFloor(">=24")).toBe(24);
    expect(parseFloor(">=24.0.0")).toBe(24);
    expect(parseFloor("^26")).toBe(26);
    expect(parseFloor("latest")).toBeUndefined();
    expect(parseCiNodeMatrix("node-version: [24, 26]")).toEqual([24, 26]);
    expect(parseCiNodeMatrix("no matrix here")).toEqual([]);
  });

  it("agrees across engines, Volta, .nvmrc, CI, Docker, and docs", () => {
    const result = checkVersionPolicy(repoInputs());
    expect(result.findings).toEqual([]);
    expect(result.floor).toBe(24);
    expect(result.ciNodes).toEqual([24, 26]);
  });

  it("reports drift instead of guessing", () => {
    const result = checkVersionPolicy({
      engines: ">=24",
      voltaNode: "22.14.0",
      nvmrc: "22",
      dockerfile: "FROM node:22-slim",
      ciYml: "node-version: [22]",
      readme: "Requires Node >= 22",
      upgrading: "Node 22 floor",
    });
    expect(result.findings.length).toBeGreaterThanOrEqual(5);
    expect(result.findings.join("\n")).toContain("Volta pin");
    expect(result.findings.join("\n")).toContain(".nvmrc");
    expect(result.findings.join("\n")).toContain("Dockerfile base");
    expect(result.findings.join("\n")).toContain("README");
  });

  it("fails on missing inputs rather than passing vacuously", () => {
    const result = checkVersionPolicy({
      engines: undefined,
      voltaNode: undefined,
      nvmrc: undefined,
      dockerfile: "",
      ciYml: "",
      readme: "",
      upgrading: "",
    });
    expect(result.findings.length).toBeGreaterThan(0);
  });
});
