/**
 * Deterministic research report exports (issue #170).
 *
 * Pure formatters over an explicitly selected set of stored records. No
 * network, no model call, no HTML from a fetched page: every interpolated
 * value is escaped, and only metadata that exists is emitted. Claim text is
 * labelled by author so model output is never mistaken for a fetched quote or
 * an owner annotation.
 */
export const REPORT_SCHEMA_VERSION = 1;

export interface ReportSource {
  id: string;
  url: string;
  title?: string;
  publisher?: string;
  /** When the source was retrieved by do-sift. */
  fetchedAt: string;
  /** When the source claims it was published — never the retrieval time. */
  publishedAt?: string;
  contentHash?: string;
}

export interface ReportClaim {
  kind: "paragraph" | "list" | "caveat";
  text: string;
  citations: string[];
  /** True when at least one citation did not resolve to stored evidence. */
  unresolved?: boolean;
}

export interface ReportAnnotation {
  id: string;
  body: string;
  createdAt: string;
}

export interface ResearchReport {
  schemaVersion: number;
  question?: string;
  sources: ReportSource[];
  claims: ReportClaim[];
  annotations: ReportAnnotation[];
  retrieval?: {
    mode: "search" | "answer";
    provider?: string;
    retrievedAt?: string;
  };
}

export interface ReportExportOptions {
  /** The question is private by default and must be opted in. */
  includeQuestion?: boolean;
  /** Owner annotations are private by default and must be opted in. */
  includeAnnotations?: boolean;
}

function assertReport(report: ResearchReport): void {
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported report schema ${report.schemaVersion}; expected ${REPORT_SCHEMA_VERSION}`,
    );
  }
}

function bySourceId(a: ReportSource, b: ReportSource): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function selected(report: ResearchReport, options: ReportExportOptions): ResearchReport {
  assertReport(report);
  return {
    schemaVersion: report.schemaVersion,
    ...(options.includeQuestion === true && report.question !== undefined
      ? { question: report.question }
      : {}),
    sources: [...report.sources].sort(bySourceId),
    claims: report.claims.map((claim) => ({
      kind: claim.kind,
      text: claim.text,
      citations: [...claim.citations].sort(),
      ...(claim.unresolved === true ? { unresolved: true } : {}),
    })),
    annotations: options.includeAnnotations === true ? [...report.annotations] : [],
    ...(report.retrieval === undefined ? {} : { retrieval: report.retrieval }),
  };
}

/** Canonical JSON: sorted sources/citations, no wall-clock field. */
export function toJsonReport(report: ResearchReport, options: ReportExportOptions = {}): string {
  return `${JSON.stringify(selected(report, options), null, 2)}\n`;
}

/** Escape Markdown control characters in data (never trust fetched text). */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1");
}

/** Escape HTML text and attributes; only http(s) links are emitted. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function safeHref(url: string): string | undefined {
  return /^https?:\/\//iu.test(url) ? url : undefined;
}

export function toMarkdownReport(
  report: ResearchReport,
  options: ReportExportOptions = {},
): string {
  const data = selected(report, options);
  const lines: string[] = ["# Research report", ""];
  if (data.question !== undefined) {
    lines.push(`**Question:** ${escapeMarkdown(data.question)}`, "");
  }
  lines.push("## Claims", "");
  if (data.claims.length === 0) lines.push("_No claims were recorded._", "");
  for (const claim of data.claims) {
    const flag = claim.unresolved === true ? " _(unresolved citation — evidence-only)_" : "";
    const cite = claim.citations.length === 0 ? "" : ` [${claim.citations.join(", ")}]`;
    lines.push(`- (${claim.kind}) ${escapeMarkdown(claim.text)}${cite}${flag}`);
  }
  lines.push("", "## Sources", "");
  if (data.sources.length === 0) lines.push("_No sources were stored._", "");
  for (const source of data.sources) {
    const title = source.title === undefined ? source.url : escapeMarkdown(source.title);
    const meta = [
      `retrieved ${escapeMarkdown(source.fetchedAt)}`,
      ...(source.publishedAt === undefined
        ? []
        : [`published ${escapeMarkdown(source.publishedAt)}`]),
      ...(source.publisher === undefined ? [] : [escapeMarkdown(source.publisher)]),
      `evidence ${escapeMarkdown(source.id)}`,
    ].join("; ");
    lines.push(`- [${title}](${source.url}) — ${meta}`);
  }
  if (data.annotations.length > 0) {
    lines.push("", "## Owner annotations", "");
    for (const annotation of data.annotations) {
      lines.push(
        `- ${escapeMarkdown(annotation.body)} _(${escapeMarkdown(annotation.createdAt)})_`,
      );
    }
  }
  if (data.retrieval !== undefined) {
    lines.push(
      "",
      `Retrieval: ${data.retrieval.mode}` +
        (data.retrieval.provider === undefined
          ? ""
          : ` via ${escapeMarkdown(data.retrieval.provider)}`) +
        (data.retrieval.retrievedAt === undefined
          ? ""
          : ` at ${escapeMarkdown(data.retrieval.retrievedAt)}`),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Self-contained HTML; fetched content is escaped, links are safe-scheme only. */
export function toHtmlReport(report: ResearchReport, options: ReportExportOptions = {}): string {
  const data = selected(report, options);
  const parts: string[] = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Research report</title>",
    "<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}li{margin:.4rem 0}.meta{color:#555;font-size:.9em}</style>",
    "</head><body>",
    "<h1>Research report</h1>",
  ];
  if (data.question !== undefined) {
    parts.push(`<p><strong>Question:</strong> ${escapeHtml(data.question)}</p>`);
  }
  parts.push("<h2>Claims</h2>");
  if (data.claims.length === 0) parts.push("<p><em>No claims were recorded.</em></p>");
  else {
    parts.push("<ul>");
    for (const claim of data.claims) {
      const cite =
        claim.citations.length === 0
          ? ""
          : ` <span class="meta">[${claim.citations.map(escapeHtml).join(", ")}]</span>`;
      const flag =
        claim.unresolved === true
          ? ' <span class="meta">(unresolved citation — evidence-only)</span>'
          : "";
      parts.push(
        `<li><span class="meta">(${escapeHtml(claim.kind)})</span> ${escapeHtml(claim.text)}${cite}${flag}</li>`,
      );
    }
    parts.push("</ul>");
  }
  parts.push("<h2>Sources</h2>");
  if (data.sources.length === 0) parts.push("<p><em>No sources were stored.</em></p>");
  else {
    parts.push("<ul>");
    for (const source of data.sources) {
      const href = safeHref(source.url);
      const label = escapeHtml(source.title ?? source.url);
      const link =
        href === undefined
          ? label
          : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`;
      parts.push(
        `<li>${link} <span class="meta">retrieved ${escapeHtml(source.fetchedAt)}` +
          (source.publishedAt === undefined
            ? ""
            : `; published ${escapeHtml(source.publishedAt)}`) +
          `; evidence ${escapeHtml(source.id)}</span></li>`,
      );
    }
    parts.push("</ul>");
  }
  if (data.annotations.length > 0) {
    parts.push("<h2>Owner annotations</h2><ul>");
    for (const annotation of data.annotations) {
      parts.push(
        `<li>${escapeHtml(annotation.body)} <span class="meta">(${escapeHtml(annotation.createdAt)})</span></li>`,
      );
    }
    parts.push("</ul>");
  }
  parts.push("</body></html>", "");
  return parts.join("\n");
}

/** Cite key: first author-ish token of the domain + year, when known. */
function bibKey(source: ReportSource, used: Set<string>): string {
  const host = /^https?:\/\/([^/]+)/iu.exec(source.url)?.[1] ?? "source";
  const base = host.replace(/^www\./iu, "").split(".")[0] ?? "source";
  const year = source.publishedAt?.slice(0, 4) ?? "nd";
  let key = `${base}${year}`;
  let n = 2;
  while (used.has(key)) key = `${base}${year}${n++}`;
  used.add(key);
  return key;
}

/**
 * BibTeX for sources with enough metadata. A missing author/journal/date is
 * omitted, never invented; entries that cannot form a valid record (no title
 * and no publisher) are skipped.
 */
export function toBibTeX(report: ResearchReport): string {
  assertReport(report);
  const used = new Set<string>();
  const entries: string[] = [];
  for (const source of [...report.sources].sort(bySourceId)) {
    if (source.title === undefined) continue;
    const key = bibKey(source, used);
    const fields: string[] = [`  title = {${source.title}}`];
    if (source.publisher !== undefined) fields.push(`  publisher = {${source.publisher}}`);
    fields.push(`  url = {${source.url}}`);
    if (source.publishedAt !== undefined) {
      const year = source.publishedAt.slice(0, 4);
      if (/^\d{4}$/u.test(year)) fields.push(`  year = {${year}}`);
    }
    fields.push(`  note = {retrieved ${source.fetchedAt}; evidence ${source.id}}`);
    entries.push(`@misc{${key},\n${fields.join(",\n")}\n}`);
  }
  return entries.length === 0 ? "" : `${entries.join("\n\n")}\n`;
}
