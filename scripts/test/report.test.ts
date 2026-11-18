import { describe, expect, it } from "vitest";
import {
  CollectionReportTooLargeError,
  MAX_COLLECTION_REPORT_ATTACHMENTS,
  REPORT_SCHEMA_VERSION,
  assertCollectionReportSize,
  buildCollectionReport,
  escapeHtml,
  escapeMarkdown,
  toBibTeX,
  toHtmlReport,
  toJsonReport,
  toMarkdownReport,
  type ResearchReport,
} from "@do-sift/contracts";

const report: ResearchReport = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  question: "What <script>alert(1)</script>?",
  retrieval: { mode: "answer", provider: "wikipedia", retrievedAt: "2026-11-17T00:00:00.000Z" },
  sources: [
    {
      id: "ev-2",
      url: "https://b.test/page",
      title: "B & <b>",
      fetchedAt: "2026-11-17T00:00:00.000Z",
      contentHash: "deadbeef",
    },
    {
      id: "ev-1",
      url: "javascript:alert(1)",
      title: "Unsafe scheme",
      fetchedAt: "2026-11-16T00:00:00.000Z",
      publishedAt: "2024-03-01T00:00:00.000Z",
      publisher: "Example",
    },
    { id: "ev-3", url: "https://c.test/x", fetchedAt: "2026-11-15T00:00:00.000Z" },
  ],
  claims: [
    { kind: "paragraph", text: "A claim *with* markdown", citations: ["ev-2", "ev-1"] },
    { kind: "caveat", text: "Unresolved", citations: ["ev-missing"], unresolved: true },
  ],
  annotations: [{ id: "n-1", body: "owner note", createdAt: "2026-11-17T01:00:00.000Z" }],
};

describe("report exports", () => {
  it("is deterministic and excludes private fields by default", () => {
    const a = toJsonReport(report);
    const b = toJsonReport(report);
    expect(a).toBe(b);
    expect(a).not.toContain("owner note");
    expect(a).not.toContain("What <script>");
    expect(a).toContain("ev-1");
  });

  it("includes private fields only when opted in", () => {
    const json = toJsonReport(report, { includeQuestion: true, includeAnnotations: true });
    expect(json).toContain("owner note");
    expect(json).toContain("What <script>");
  });

  it("sorts sources and citations for stable output", () => {
    const parsed = JSON.parse(toJsonReport(report)) as ResearchReport;
    expect(parsed.sources.map((s) => s.id)).toEqual(["ev-1", "ev-2", "ev-3"]);
    expect(parsed.claims[0]?.citations).toEqual(["ev-1", "ev-2"]);
  });

  it("escapes markdown and HTML, and refuses unsafe link schemes", () => {
    expect(escapeMarkdown("a*b_c")).toBe("a\\*b\\_c");
    expect(escapeHtml("<b>&\"'")).toBe("&lt;b&gt;&amp;&quot;&#39;");
    const html = toHtmlReport(report, { includeQuestion: true });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(toMarkdownReport(report)).not.toContain("What <script>");
  });

  it("identifies a collection report and escapes its metadata", () => {
    const collection = buildCollectionReport({
      title: "Reading *list*",
      description: "<b>Owner context</b>",
      createdAt: "2026-11-18T00:00:00Z",
      sources: [],
      annotations: [],
    });
    const json = JSON.parse(toJsonReport(collection)) as ResearchReport;
    expect(json.collection).toEqual({
      title: "Reading *list*",
      description: "<b>Owner context</b>",
    });

    const markdown = toMarkdownReport(collection);
    expect(markdown).toContain("**Collection:** Reading \\*list\\*");
    expect(markdown).toContain("<b\\>Owner context</b\\>");

    const html = toHtmlReport(collection);
    expect(html).toContain("<strong>Collection:</strong> Reading *list*");
    expect(html).toContain("&lt;b&gt;Owner context&lt;/b&gt;");
    expect(html).not.toContain("<b>Owner context</b>");
  });

  it("refuses a collection report above the attachment safety ceiling", () => {
    const sources = Array.from({ length: MAX_COLLECTION_REPORT_ATTACHMENTS + 1 }, (_, index) => ({
      id: `src-${index}`,
      url: "https://example.test/page",
      fetchedAt: "2026-11-18T00:00:00Z",
    }));
    expect(() =>
      buildCollectionReport({
        title: "Too large",
        description: "",
        createdAt: "2026-11-18T00:00:00Z",
        sources,
        annotations: [],
      }),
    ).toThrow(CollectionReportTooLargeError);
    expect(() => assertCollectionReportSize(MAX_COLLECTION_REPORT_ATTACHMENTS + 1)).toThrow(
      CollectionReportTooLargeError,
    );
  });

  it("emits only present BibTeX metadata and skips entries without a title", () => {
    const bib = toBibTeX(report);
    expect(bib).toContain("@misc{");
    expect(bib).toContain("title = {B & <b>}");
    expect(bib).toContain("publisher = {Example}");
    expect(bib).toContain("year = {2024}");
    // the untitled source is omitted rather than invented
    expect(bib).not.toContain("c.test");
    expect(bib.match(/@misc\{/gu)).toHaveLength(2);
  });
});
