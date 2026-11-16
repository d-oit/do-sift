/**
 * advisory-triage tests (issue #174). Pure over parsed audit JSON plus an
 * exceptions list, so every branch is provable without the registry.
 */
import { describe, expect, it } from "vitest";
import {
  formatMarkdownReport,
  parseAuditReport,
  triageVulnerabilities,
} from "../advisory-triage.js";

const NOW = new Date("2026-11-16T00:00:00Z");

function audit(severity: string, name = "left-pad", via: unknown = ["GHSA-test-1234"]) {
  return {
    vulnerabilities: {
      [name]: {
        name,
        severity,
        via,
        fixAvailable: true,
        title: `${name} test advisory`,
      },
    },
  };
}

describe("parseAuditReport", () => {
  it("parses npm v7+ vulnerabilities", () => {
    const vulns = parseAuditReport(audit("high", "left-pad", ["GHSA-xxxx-yyyy-zzzz"]));
    expect(vulns).toHaveLength(1);
    expect(vulns[0]?.name).toBe("left-pad");
    expect(vulns[0]?.severity).toBe("high");
  });

  it("returns empty for non-object input", () => {
    expect(parseAuditReport(undefined)).toEqual([]);
    expect(parseAuditReport("nope")).toEqual([]);
  });

  it("skips entries with unknown severity", () => {
    expect(parseAuditReport(audit("unknown-severity"))).toEqual([]);
  });

  it("accepts the legacy advisories shape", () => {
    const vulns = parseAuditReport({
      advisories: {
        123: {
          module_name: "old-thing",
          severity: "critical",
          title: "legacy",
          url: "https://example.test/advisory",
          patched_versions: ">=2.0.1",
        },
      },
    });
    expect(vulns).toHaveLength(1);
    expect(vulns[0]?.severity).toBe("critical");
  });
});

describe("triageVulnerabilities", () => {
  it("passes on zero vulnerabilities", () => {
    const { report, findings } = triageVulnerabilities([], [], NOW);
    expect(findings).toEqual([]);
    expect(report.blocking).toEqual([]);
  });

  it("fails high/critical without an exception", () => {
    const vulns = parseAuditReport(audit("high"));
    const { findings } = triageVulnerabilities(vulns, [], NOW);
    expect(findings.map((f) => f.kind)).toEqual(["advisory-high"]);
  });

  it("reports moderate without failing", () => {
    const vulns = parseAuditReport(audit("moderate"));
    const { report, findings } = triageVulnerabilities(vulns, [], NOW);
    expect(findings).toEqual([]);
    expect(report.nonBlocking).toHaveLength(1);
  });

  it("suppresses a matching package exception", () => {
    const vulns = parseAuditReport(audit("critical", "left-pad", ["GHSA-aaaa-bbbb-cccc"]));
    const { findings, report } = triageVulnerabilities(
      vulns,
      [
        {
          id: "EXC-001",
          package: "left-pad",
          severity: "critical",
          rationale: "Dev-only path, no production reachability.",
          owner: "@d-oit",
          expires: "2027-02-16",
        },
      ],
      NOW,
    );
    expect(findings).toEqual([]);
    expect(report.suppressed.map((s) => s.exceptionId)).toEqual(["EXC-001"]);
  });

  it("matches exceptions by advisory id", () => {
    const vulns = parseAuditReport(
      audit("high", "some-dep", ["https://github.com/advisories/GHSA-abcd-efgh-ijkl"]),
    );
    const { findings } = triageVulnerabilities(
      vulns,
      [
        {
          id: "EXC-002",
          advisory: "GHSA-abcd-efgh-ijkl",
          severity: "high",
          rationale: "Upstream fix pending, exposure documented.",
          owner: "@d-oit",
          expires: "2027-01-01",
        },
      ],
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("fails expired exceptions", () => {
    const vulns = parseAuditReport(audit("high"));
    const { findings } = triageVulnerabilities(
      vulns,
      [
        {
          id: "EXC-003",
          package: "left-pad",
          severity: "high",
          rationale: "Stale rationale that should have been renewed.",
          owner: "@d-oit",
          expires: "2026-01-01",
        },
      ],
      NOW,
    );
    expect(findings.map((f) => f.kind)).toContain("expired-exception");
    expect(findings.map((f) => f.kind)).toContain("advisory-high");
  });

  it("fails invalid exceptions missing rationale/owner/expiry", () => {
    const { findings } = triageVulnerabilities([], [{ id: "EXC-004", package: "left-pad" }], NOW);
    expect(findings.map((f) => f.kind)).toContain("invalid-exception");
  });

  it("fails stale exceptions that match nothing current", () => {
    const { findings } = triageVulnerabilities(
      [],
      [
        {
          id: "EXC-005",
          package: "gone-dep",
          severity: "high",
          rationale: "Kept after the dependency was removed.",
          owner: "@d-oit",
          expires: "2027-01-01",
        },
      ],
      NOW,
    );
    expect(findings.map((f) => f.kind)).toContain("stale-exception");
  });

  it("renders a markdown report with counts and findings", () => {
    const vulns = parseAuditReport(audit("critical"));
    const { report, findings } = triageVulnerabilities(vulns, [], NOW);
    const md = formatMarkdownReport(vulns, report, findings);
    expect(md).toContain("critical 1");
    expect(md).toContain("advisory-critical");
  });
});
