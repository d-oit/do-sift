/**
 * Deterministic research report export (#170).
 *
 * Reads a canonical report JSON document and writes exactly one format. The
 * output path must not exist unless `--force` is passed; the write is atomic.
 * Pure formatters live in `packages/contracts/src/report.ts` — this file only
 * handles selection, CLI validation, and file output.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  REPORT_SCHEMA_VERSION,
  toBibTeX,
  toHtmlReport,
  toJsonReport,
  toMarkdownReport,
  type ResearchReport,
} from "@do-sift/contracts";

const FORMATS = ["json", "markdown", "html", "bibtex"] as const;
type Format = (typeof FORMATS)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function main(): number {
  const input = arg("in");
  const out = arg("out");
  const format = arg("format") as Format | undefined;
  if (input === undefined || out === undefined || format === undefined) {
    throw new Error("--in, --out, and --format are required");
  }
  if (!FORMATS.includes(format)) {
    throw new Error(`--format must be one of: ${FORMATS.join(", ")}`);
  }

  const report = JSON.parse(readFileSync(input, "utf8")) as ResearchReport;
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported report schema ${report.schemaVersion}; this exporter writes ${REPORT_SCHEMA_VERSION}`,
    );
  }

  const options = {
    includeQuestion: process.argv.includes("--include-question"),
    includeAnnotations: process.argv.includes("--include-annotations"),
  };
  const rendered =
    format === "json"
      ? toJsonReport(report, options)
      : format === "markdown"
        ? toMarkdownReport(report, options)
        : format === "html"
          ? toHtmlReport(report, options)
          : toBibTeX(report);

  const force = process.argv.includes("--force");
  if (!force && existsSync(out)) {
    throw new Error(`${out} already exists; pass --force to replace it`);
  }
  const tmp = `${out}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, rendered, { flag: "wx" });
    renameSync(tmp, out);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }

  const bytes = Buffer.byteLength(rendered, "utf8");
  console.log(`export: wrote ${format} (${bytes} bytes) to ${out}`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`export: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
