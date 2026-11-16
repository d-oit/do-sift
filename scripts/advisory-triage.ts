/**
 * Advisory triage for scheduled dependency scans (issue #174).
 *
 * Reads `npm audit --json` output plus `policies/dependency-exceptions.json`
 * and triages by severity and exploitability, not by raw count:
 *
 * - `high` / `critical` findings without a valid, unexpired exception fail.
 * - `moderate` / `low` / `info` findings are reported but do not fail alone.
 * - Every exception needs an id, a package or advisory match, a severity,
 *   a rationale, an owner, and an expiry date (YYYY-MM-DD). Expired or
 *   malformed exceptions fail.
 * - An exception that matches nothing currently reported is stale and fails,
 *   so the file cannot outlive the problem (same rule as deps-check.ts).
 *
 * Network-free and deterministic (INV-006): this script never contacts the
 * registry. The workflow captures `npm audit --json` first; locally, pass a
 * fixture with `--audit`. Zero vulnerabilities is a PASS, not a vacuous
 * failure — an empty advisory set is the desired state.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export function parseSeverity(value: unknown): Severity | undefined {
  if (value === "info" || value === "low" || value === "moderate") return value;
  if (value === "high" || value === "critical") return value;
  return undefined;
}

export interface TriageVulnerability {
  name: string;
  severity: Severity;
  via: string[];
  fixAvailable: boolean;
  title: string;
}

export interface TriageException {
  id?: string;
  package?: string;
  advisory?: string;
  severity?: string;
  rationale?: string;
  owner?: string;
  expires?: string;
  review?: string;
}

export interface TriageReport {
  counts: Record<Severity, number>;
  blocking: TriageVulnerability[];
  nonBlocking: TriageVulnerability[];
  suppressed: Array<{ vulnerability: TriageVulnerability; exceptionId: string }>;
  notes: string[];
}

export interface TriageFinding {
  kind: string;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viaStrings(via: unknown): string[] {
  if (!Array.isArray(via)) return [];
  const out: string[] = [];
  for (const entry of via) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (isRecord(entry)) {
      const url = entry["url"];
      const title = entry["title"];
      if (typeof url === "string" && url.length > 0) out.push(url);
      else if (typeof title === "string" && title.length > 0) out.push(title);
    }
  }
  return out;
}

function advisoryIds(via: unknown): string[] {
  return viaStrings(via).flatMap((s) => {
    const ids: string[] = [];
    const ghsa = s.match(/GHSA-[a-z0-9-]{4,}/giu);
    if (ghsa) ids.push(...ghsa.map((g) => g.toUpperCase()));
    const cve = s.match(/CVE-\d{4}-\d{4,}/giu);
    if (cve) ids.push(...cve.map((c) => c.toUpperCase()));
    // npm also emits bare advisory names through `via` strings.
    if (s.length > 0 && ids.length === 0) ids.push(s);
    return ids;
  });
}

function fixAvailableText(value: unknown): { available: boolean; label: string } {
  if (value === true) return { available: true, label: "fix available" };
  if (value === false) return { available: false, label: "no fix available" };
  if (isRecord(value)) {
    const name = value["name"];
    const version = value["version"];
    if (typeof name === "string" && typeof version === "string") {
      return { available: true, label: `fix available: ${name}@${version}` };
    }
    return { available: true, label: "fix available" };
  }
  return { available: false, label: "fix status unknown" };
}

/**
 * Parse the `vulnerabilities` map of `npm audit --json` (npm v7+). Older
 * `advisories` maps are also accepted so fixtures can use either shape.
 */
export function parseAuditReport(json: unknown): TriageVulnerability[] {
  if (!isRecord(json)) return [];
  const out: TriageVulnerability[] = [];

  const vulns = json["vulnerabilities"];
  if (isRecord(vulns)) {
    for (const [name, raw] of Object.entries(vulns)) {
      if (!isRecord(raw)) continue;
      const severity = parseSeverity(raw["severity"]);
      if (severity === undefined) continue;
      const fix = fixAvailableText(raw["fixAvailable"]);
      const titleRaw = raw["title"];
      const title = typeof titleRaw === "string" ? titleRaw : "";
      out.push({
        name,
        severity,
        via: viaStrings(raw["via"]),
        fixAvailable: fix.available,
        title,
      });
    }
    return out;
  }

  const advisories = json["advisories"];
  if (isRecord(advisories)) {
    for (const raw of Object.values(advisories)) {
      if (!isRecord(raw)) continue;
      const severity = parseSeverity(raw["severity"]);
      if (severity === undefined) continue;
      const nameRaw = raw["module_name"];
      const name = typeof nameRaw === "string" ? nameRaw : "unknown";
      const titleRaw = raw["title"];
      const title = typeof titleRaw === "string" ? titleRaw : "";
      const urlRaw = raw["url"];
      const via = typeof urlRaw === "string" ? [urlRaw] : [];
      const fixRaw = raw["patched_versions"];
      out.push({
        name,
        severity,
        via,
        fixAvailable: typeof fixRaw === "string" && fixRaw !== "<0.0.0",
        title,
      });
    }
  }
  return out;
}

function exceptionMatches(exception: TriageException, vuln: TriageVulnerability): boolean {
  if (typeof exception.package === "string" && exception.package === vuln.name) {
    return true;
  }
  if (typeof exception.advisory === "string" && exception.advisory.length > 0) {
    const want = exception.advisory.toUpperCase();
    const ids = advisoryIds(vuln.via).map((s) => s.toUpperCase());
    if (ids.includes(want)) return true;
    if (vuln.via.some((s) => s.toUpperCase().includes(want))) return true;
  }
  return false;
}

function isExpired(exception: TriageException, now: Date): boolean {
  if (typeof exception.expires !== "string") return true;
  const parsed = new Date(`${exception.expires}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return true;
  return parsed.getTime() < now.getTime();
}

export function triageVulnerabilities(
  vulnerabilities: readonly TriageVulnerability[],
  exceptions: readonly TriageException[],
  now: Date = new Date(),
): { report: TriageReport; findings: TriageFinding[] } {
  const findings: TriageFinding[] = [];
  const counts: Record<Severity, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const vuln of vulnerabilities) {
    counts[vuln.severity] += 1;
  }

  // Validate exception shape first: a suppression without rationale, owner
  // and expiry is itself a finding.
  const validExceptions: TriageException[] = [];
  for (const exception of exceptions) {
    const id = typeof exception.id === "string" ? exception.id : "(missing id)";
    const missing: string[] = [];
    if (typeof exception.id !== "string" || exception.id.length === 0) missing.push("id");
    if (
      (typeof exception.package !== "string" || exception.package.length === 0) &&
      (typeof exception.advisory !== "string" || exception.advisory.length === 0)
    ) {
      missing.push("package or advisory");
    }
    if (typeof exception.rationale !== "string" || exception.rationale.length < 10) {
      missing.push("rationale (>= 10 chars)");
    }
    if (typeof exception.owner !== "string" || exception.owner.length === 0) {
      missing.push("owner");
    }
    if (typeof exception.expires !== "string" || Number.isNaN(Date.parse(exception.expires))) {
      missing.push("expires (YYYY-MM-DD)");
    }
    if (missing.length > 0) {
      findings.push({
        kind: "invalid-exception",
        detail: `exception ${id} is missing: ${missing.join(", ")}`,
      });
      continue;
    }
    if (isExpired(exception, now)) {
      findings.push({
        kind: "expired-exception",
        detail: `exception ${id} expired on ${exception.expires ?? "unknown date"}`,
      });
      continue;
    }
    validExceptions.push(exception);
  }

  const blocking: TriageVulnerability[] = [];
  const nonBlocking: TriageVulnerability[] = [];
  const suppressed: Array<{ vulnerability: TriageVulnerability; exceptionId: string }> = [];
  const usedExceptionIds = new Set<string>();

  for (const vuln of vulnerabilities) {
    const match = validExceptions.find((e) => exceptionMatches(e, vuln));
    if (match !== undefined && typeof match.id === "string") {
      suppressed.push({ vulnerability: vuln, exceptionId: match.id });
      usedExceptionIds.add(match.id);
      continue;
    }
    if (SEVERITY_ORDER[vuln.severity] >= SEVERITY_ORDER["high"]) {
      blocking.push(vuln);
    } else {
      nonBlocking.push(vuln);
    }
  }

  for (const vuln of blocking) {
    const fixNote = vuln.fixAvailable ? "fix available" : "no fix available";
    const where = vuln.via.length > 0 ? ` via ${vuln.via.slice(0, 2).join(", ")}` : "";
    findings.push({
      kind: `advisory-${vuln.severity}`,
      detail: `${vuln.name} [${vuln.severity}] (${fixNote})${where}`,
    });
  }

  // Stale suppressions must be removed so the file cannot outlive the fix.
  for (const exception of validExceptions) {
    if (typeof exception.id !== "string") continue;
    if (!usedExceptionIds.has(exception.id)) {
      const target = exception.package ?? exception.advisory ?? exception.id;
      findings.push({
        kind: "stale-exception",
        detail: `exception ${exception.id} (${target}) matches nothing in the current audit; remove it`,
      });
    }
  }

  const notes: string[] = [];
  for (const vuln of nonBlocking) {
    const fixNote = vuln.fixAvailable ? "fix available" : "no fix available";
    notes.push(`${vuln.name} [${vuln.severity}] (${fixNote}) — reported, not blocking`);
  }
  for (const entry of suppressed) {
    notes.push(
      `${entry.vulnerability.name} [${entry.vulnerability.severity}] suppressed by ${entry.exceptionId}`,
    );
  }

  return { report: { counts, blocking, nonBlocking, suppressed, notes }, findings };
}

export function formatMarkdownReport(
  vulnerabilities: readonly TriageVulnerability[],
  report: TriageReport,
  findings: readonly TriageFinding[],
): string {
  const lines: string[] = [];
  lines.push("# Dependency scan triage");
  lines.push("");
  lines.push(
    `Counts: info ${report.counts.info}, low ${report.counts.low}, moderate ${report.counts.moderate}, high ${report.counts.high}, critical ${report.counts.critical}.`,
  );
  lines.push(`Vulnerabilities: ${vulnerabilities.length}; blocking: ${report.blocking.length}.`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("Result: PASS — no blocking advisories and no exception hygiene findings.");
  } else {
    lines.push(`Result: FAIL — ${findings.length} finding(s):`);
    for (const finding of findings) {
      lines.push(`- [${finding.kind}] ${finding.detail}`);
    }
  }
  lines.push("");
  if (report.notes.length > 0) {
    lines.push("## Notes (non-blocking and suppressed)");
    lines.push("");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }
  lines.push("Policy: high/critical without a valid unexpired exception blocks.");
  lines.push("Moderate/low/info are reported. Exceptions require rationale, owner and expiry.");
  lines.push("");
  return lines.join("\n");
}

interface CliOptions {
  auditPath: string;
  exceptionsPath: string;
  reportPath?: string;
}

function parseArgs(argv: readonly string[]): CliOptions | undefined {
  let auditPath: string | undefined;
  let exceptionsPath: string | undefined;
  let reportPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--audit") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        auditPath = next;
        i += 1;
      }
    } else if (arg === "--exceptions") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        exceptionsPath = next;
        i += 1;
      }
    } else if (arg === "--report") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        reportPath = next;
        i += 1;
      }
    }
  }
  if (auditPath === undefined || exceptionsPath === undefined) return undefined;
  const options: CliOptions = { auditPath, exceptionsPath };
  if (reportPath !== undefined) options.reportPath = reportPath;
  return options;
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) {
    console.error(
      "advisory-triage: FAIL — usage: --audit <audit.json> --exceptions <exceptions.json> [--report <report.md>]",
    );
    process.exit(1);
  }
  if (!existsSync(options.auditPath)) {
    console.error(`advisory-triage: FAIL — audit file not found: ${options.auditPath}`);
    process.exit(1);
  }
  if (!existsSync(options.exceptionsPath)) {
    console.error(`advisory-triage: FAIL — exceptions file not found: ${options.exceptionsPath}`);
    process.exit(1);
  }

  let auditJson: unknown;
  let exceptionsJson: unknown;
  try {
    auditJson = loadJson(options.auditPath);
  } catch {
    console.error(`advisory-triage: FAIL — audit file is not valid JSON: ${options.auditPath}`);
    process.exit(1);
  }
  try {
    exceptionsJson = loadJson(options.exceptionsPath);
  } catch {
    console.error(
      `advisory-triage: FAIL — exceptions file is not valid JSON: ${options.exceptionsPath}`,
    );
    process.exit(1);
  }

  const vulnerabilities = parseAuditReport(auditJson);
  const exceptions: readonly TriageException[] = Array.isArray(
    (exceptionsJson as { exceptions?: unknown })["exceptions"],
  )
    ? ((exceptionsJson as { exceptions: TriageException[] })["exceptions"] as TriageException[])
    : [];

  const { report, findings } = triageVulnerabilities(vulnerabilities, exceptions, new Date());

  if (options.reportPath !== undefined) {
    writeFileSync(options.reportPath, formatMarkdownReport(vulnerabilities, report, findings));
  }

  const summary =
    `info ${report.counts.info}, low ${report.counts.low}, moderate ${report.counts.moderate}, ` +
    `high ${report.counts.high}, critical ${report.counts.critical}`;
  if (findings.length > 0) {
    console.error(`advisory-triage: FAIL (${findings.length} finding(s); ${summary})`);
    for (const finding of findings) console.error(`  [${finding.kind}] ${finding.detail}`);
    process.exit(1);
  }
  console.log(`advisory-triage: PASS (${vulnerabilities.length} vulnerabilit(ies); ${summary})`);
  for (const note of report.notes) console.log(`  note: ${note}`);
}

/* CLI entrypoint only; importable by tests without side effects. */
const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("advisory-triage.ts") ||
    process.argv[1].endsWith("advisory-triage.js"));

if (isEntrypoint) main();

export const __defaultPaths = { root: join(ROOT, "package.json") };
