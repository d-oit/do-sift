/**
 * CODEOWNERS coverage check (CLS-07): docs/github-hardening.md is the SSOT for
 * sensitive paths, so every path in its table must have an explicit
 * .github/CODEOWNERS rule with an owner. Fixtures only — the repo itself is
 * checked by the `governance` sensor.
 */
import { describe, expect, it } from "vitest";
import {
  checkCodeownersCoverage,
  findCoveringRule,
  normalizePath,
  parseCodeowners,
  parseDocumentedPaths,
} from "../codeowners.js";

const DOC = `# Hardening

## Sensitive paths

| Path                            | Why                     |
| ------------------------------- | ----------------------- |
| \`AGENTS.md\`                     | contract                |
| \`plans/adr/\`                    | immutable decisions     |
| \`do-harness.toml\`, \`.githooks/\` | tooling                 |

## Recommended protections

| \`not-sensitive.md\` | outside the section |
`;

const OWNERS = `# comment — ignored
*                       @owner

/AGENTS.md              @owner
/plans/adr/             @owner
/do-harness.toml        @owner
/.githooks/             @owner
`;

describe("normalizePath", () => {
  it("strips anchoring, leading ./, trailing slashes and backslashes", () => {
    expect(normalizePath("/AGENTS.md")).toBe("AGENTS.md");
    expect(normalizePath("./plans/adr/")).toBe("plans/adr");
    expect(normalizePath("plans\\adr\\")).toBe("plans/adr");
  });
});

describe("parseDocumentedPaths", () => {
  it("reads every backticked path in the Sensitive paths table only", () => {
    expect(parseDocumentedPaths(DOC)).toEqual([
      "AGENTS.md",
      "plans/adr",
      "do-harness.toml",
      ".githooks",
    ]);
  });

  it("returns an empty list when the section is missing (fail-closed caller)", () => {
    expect(parseDocumentedPaths("# nothing here\n\n| `a.md` | x |\n")).toEqual([]);
  });
});

describe("parseCodeowners", () => {
  it("skips comments and blank lines and keeps owners with line numbers", () => {
    const rules = parseCodeowners(OWNERS);
    expect(rules.map((r) => [r.pattern, r.owners, r.line])).toEqual([
      ["*", ["@owner"], 2],
      ["/AGENTS.md", ["@owner"], 4],
      ["/plans/adr/", ["@owner"], 5],
      ["/do-harness.toml", ["@owner"], 6],
      ["/.githooks/", ["@owner"], 7],
    ]);
  });
});

describe("findCoveringRule", () => {
  const rules = parseCodeowners(OWNERS);

  it("matches an exact normalized path", () => {
    expect(findCoveringRule(rules, "/AGENTS.md")?.pattern).toBe("/AGENTS.md");
  });

  it("lets a directory rule cover its descendants", () => {
    expect(findCoveringRule(rules, "plans/adr/ADR-0001.md")?.pattern).toBe("/plans/adr/");
  });

  it("does not treat the wildcard rule as explicit coverage", () => {
    expect(findCoveringRule(rules, "scripts/policy.ts")).toBeUndefined();
  });
});

describe("checkCodeownersCoverage", () => {
  it("passes when every documented path has an owned rule", () => {
    expect(checkCodeownersCoverage({ markdown: DOC, codeowners: OWNERS })).toEqual([]);
  });

  it("reports a documented path with no rule", () => {
    const findings = checkCodeownersCoverage({
      markdown: DOC,
      codeowners: OWNERS.replace("/do-harness.toml        @owner\n", ""),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"do-harness.toml"');
  });

  it("reports a rule without an owner", () => {
    const findings = checkCodeownersCoverage({
      markdown: DOC,
      codeowners: `${OWNERS}/extra.md\n`,
    });
    expect(findings).toEqual([expect.stringContaining('pattern "/extra.md" has no owner')]);
  });

  it("reports a malformed owner token", () => {
    const findings = checkCodeownersCoverage({
      markdown: DOC,
      codeowners: `${OWNERS}/extra.md owner\n`,
    });
    expect(findings).toEqual([expect.stringContaining('invalid owner "owner"')]);
  });

  it("fails closed when the guide documents no sensitive paths", () => {
    const findings = checkCodeownersCoverage({ markdown: "# empty\n", codeowners: OWNERS });
    expect(findings).toEqual([expect.stringContaining("no documented sensitive paths")]);
  });
});
