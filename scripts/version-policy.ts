/**
 * Node support-policy consistency sensor (issue #167).
 *
 * One promise has to agree in five places: `engines.node`, the Volta pin, the
 * `.nvmrc` default, the CI matrix, and the Docker base tag. Prose is checked
 * for the floor it claims (`>=24`) so the upgrade guide cannot drift back to a
 * retired Node line.
 *
 * Network-free and deterministic (INV-006); a missing input is a failure, not
 * a skipped check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VersionPolicyInputs {
  engines: string | undefined;
  voltaNode: string | undefined;
  nvmrc: string | undefined;
  dockerfile: string;
  ciYml: string;
  readme: string;
  upgrading: string;
}

export interface VersionPolicyResult {
  findings: string[];
  floor: number;
  ciNodes: number[];
}

/** Minimum major from a range like `>=24`, `>=24.0.0`, or `^24`. */
export function parseFloor(range: string | undefined): number | undefined {
  if (range === undefined) return undefined;
  const m = />=\s*(\d+)/u.exec(range) ?? /\^\s*(\d+)/u.exec(range);
  if (m?.[1] === undefined) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Major versions listed in the `node-version` matrix of a CI workflow. */
export function parseCiNodeMatrix(ciYml: string): number[] {
  const versions = new Set<number>();
  const re = /node-version:\s*\[([^\]]+)\]/gu;
  for (const match of ciYml.matchAll(re)) {
    for (const part of (match[1] ?? "").split(",")) {
      const n = Number(part.trim().replace(/["']/gu, ""));
      if (Number.isInteger(n) && n > 0) versions.add(n);
    }
  }
  return [...versions].sort((a, b) => a - b);
}

/** True when the text contains `>=<floor>` (optional spaces) not followed by a digit. */
export function statesFloor(text: string, floor: number): boolean {
  const digits = String(floor);
  let index = text.indexOf(">=");
  while (index !== -1) {
    let cursor = index + 2;
    while (text[cursor] === " ") cursor += 1;
    if (text.startsWith(digits, cursor)) {
      const next = text[cursor + digits.length];
      if (next === undefined || next < "0" || next > "9") return true;
    }
    index = text.indexOf(">=", index + 1);
  }
  return false;
}

export function checkVersionPolicy(input: VersionPolicyInputs): VersionPolicyResult {
  const findings: string[] = [];
  const floor = parseFloor(input.engines);
  if (floor === undefined) {
    findings.push("package.json engines.node does not name a minimum major (e.g. >=24)");
  }

  const voltaMajor =
    input.voltaNode === undefined ? undefined : Number(input.voltaNode.split(".")[0]);
  if (voltaMajor === undefined || !Number.isInteger(voltaMajor)) {
    findings.push("package.json volta.node is missing or not a version");
  }

  const nvmrcMajor = input.nvmrc === undefined ? undefined : Number(input.nvmrc.trim());
  if (nvmrcMajor === undefined || !Number.isInteger(nvmrcMajor)) {
    findings.push(".nvmrc is missing or not a major version");
  }

  const ciNodes = parseCiNodeMatrix(input.ciYml);
  if (ciNodes.length === 0) {
    findings.push("CI declares no node-version matrix");
  }

  if (floor !== undefined) {
    if (voltaMajor !== undefined && voltaMajor < floor) {
      findings.push(`Volta pin ${input.voltaNode} is below the declared floor ${floor}`);
    }
    if (nvmrcMajor !== undefined && nvmrcMajor < floor) {
      findings.push(`.nvmrc ${input.nvmrc} is below the declared floor ${floor}`);
    }
    for (const node of ciNodes) {
      if (node < floor) findings.push(`CI matrix tests Node ${node}, below the floor ${floor}`);
    }
    const docker = /FROM\s+node:(\d+)/u.exec(input.dockerfile);
    if (docker?.[1] === undefined) {
      findings.push("Dockerfile has no node:<major> base image");
    } else if (Number(docker[1]) < floor) {
      findings.push(`Dockerfile base node:${docker[1]} is below the floor ${floor}`);
    }
    if (!statesFloor(input.readme, floor)) {
      findings.push(`README does not state the Node >=${floor} floor`);
    }
    if (!statesFloor(input.upgrading, floor)) {
      findings.push(`docs/upgrading.md does not state the Node >=${floor} floor`);
    }
  }

  return { findings, floor: floor ?? 0, ciNodes };
}

function read(path: string): string | undefined {
  const full = join(process.cwd(), path);
  if (!existsSync(full)) return undefined;
  return readFileSync(full, "utf8");
}

function main(): number {
  const pkg = JSON.parse(read("package.json") ?? "{}") as {
    engines?: { node?: string };
    volta?: { node?: string };
  };
  const result = checkVersionPolicy({
    engines: pkg.engines?.node,
    voltaNode: pkg.volta?.node,
    nvmrc: read(".nvmrc"),
    dockerfile: read("Dockerfile") ?? "",
    ciYml: read(".github/workflows/ci.yml") ?? "",
    readme: read("README.md") ?? "",
    upgrading: read("docs/upgrading.md") ?? "",
  });

  if (result.findings.length > 0) {
    console.error(`version-policy: FAIL (${result.findings.length} finding(s))`);
    for (const f of result.findings) console.error(`  ${f}`);
    return 1;
  }
  console.log(`version-policy: PASS (floor >=${result.floor}; CI ${result.ciNodes.join(", ")})`);
  return 0;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("version-policy.ts") || process.argv[1].endsWith("version-policy.js"));

if (isEntrypoint) process.exit(main());
