import { describe, expect, it } from "vitest";
import {
  checkLinks,
  headingAnchors,
  relativeLinks,
  resolveTarget,
  slugify,
  stripCode,
} from "../links.js";

describe("stripCode", () => {
  it("blanks fenced code blocks but keeps surrounding lines", () => {
    const text = ["before", "```md", "[broken](missing.md)", "```", "after"].join("\n");
    const stripped = stripCode(text);
    expect(stripped).not.toContain("broken");
    expect(stripped).toContain("before");
    expect(stripped).toContain("after");
    expect(stripped.split("\n")).toHaveLength(5);
  });

  it("blanks a tilde fence and an unterminated fence to end of file", () => {
    expect(stripCode("~~~\n[x](y.md)\n~~~\nkept")).toContain("kept");
    expect(stripCode("```\n[x](y.md)\nkept")).not.toContain("kept");
  });

  it("blanks inline code spans", () => {
    const stripped = stripCode("see `[a](b.md)` here");
    expect(stripped).not.toContain("a](b.md)");
    expect(stripped).toContain("here");
  });
});

describe("slugify", () => {
  it("follows GitHub's heading slug rules", () => {
    expect(slugify("Sensitive paths")).toBe("sensitive-paths");
    expect(slugify("Closing outcome — 2026-09-29")).toBe("closing-outcome--2026-09-29");
    expect(slugify("`plans/adr/`")).toBe("plansadr");
    expect(slugify("  Trailing #  ")).toBe("trailing");
  });
});

describe("headingAnchors", () => {
  it("collects ATX headings and suffixes duplicates in order", () => {
    const anchors = headingAnchors("# A\n\n## B\n\n## B\n\ntext\n\n### C ##\n");
    expect([...anchors]).toEqual(["a", "b", "b-1", "c"]);
  });

  it("ignores headings inside fenced code", () => {
    const anchors = headingAnchors("## Real\n\n```\n## NotReal\n```\n");
    expect([...anchors]).toEqual(["real"]);
  });
});

describe("relativeLinks", () => {
  it("keeps relative links and anchors, drops absolute ones, reports 1-based lines", () => {
    const md = [
      "# T",
      "[a](docs/a.md)",
      "[b](https://example.test/x)",
      "[c](#anchor)",
      "[d](mailto:x@y.test)",
      "[e](//cdn.test/x)",
    ].join("\n");
    expect(relativeLinks(md)).toEqual([
      { line: 2, target: "docs/a.md" },
      { line: 4, target: "#anchor" },
    ]);
  });

  it("reads reference definitions", () => {
    expect(relativeLinks("[x]: plans/035.md\n")).toEqual([{ line: 1, target: "plans/035.md" }]);
  });

  it("ignores links inside code fences", () => {
    expect(relativeLinks("```\n[a](b.md)\n```\n")).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("resolves same-directory and parent-directory targets", () => {
    expect(resolveTarget("docs/a.md", "b.md")).toEqual({ path: "docs/b.md" });
    expect(resolveTarget("docs/a.md", "../plans/000.md")).toEqual({ path: "plans/000.md" });
  });

  it("resolves repo-root-absolute targets", () => {
    expect(resolveTarget("plans/adr/0001.md", "/docs/api.md")).toEqual({ path: "docs/api.md" });
  });

  it("splits anchors and ignores query strings", () => {
    expect(resolveTarget("docs/a.md", "b.md#limits")).toEqual({
      path: "docs/b.md",
      anchor: "limits",
    });
    expect(resolveTarget("docs/a.md", "b.md?x=1#y")).toEqual({ path: "docs/b.md", anchor: "y" });
  });

  it("treats a pure fragment as the same document", () => {
    expect(resolveTarget("docs/a.md", "#limits")).toEqual({ path: "docs/a.md", anchor: "limits" });
    expect(resolveTarget("docs/a.md", "#")).toEqual({ path: "docs/a.md" });
  });

  it("refuses to escape the repository", () => {
    expect(resolveTarget("README.md", "../../etc/passwd")).toBe("outside-repo");
    expect(resolveTarget("docs/a.md", "../../secret.md")).toBe("outside-repo");
  });

  it("decodes percent-encoded paths", () => {
    expect(resolveTarget("docs/a.md", "my%20file.md")).toEqual({ path: "docs/my file.md" });
  });
});

describe("checkLinks", () => {
  const files = new Map<string, string>([
    ["README.md", "# Do\n\n[docs](docs/a.md)\n[anchor](docs/a.md#limits)\n"],
    ["docs/a.md", "# A\n\n## Limits\n"],
    ["plans/gone.md", "# G\n\n[dangling](docs/missing.md)\n[bad-anchor](../docs/a.md#nope)\n"],
  ]);

  it("returns no findings when every link and anchor resolves", () => {
    expect(checkLinks({ files, scan: ["README.md", "docs/a.md"] })).toEqual([]);
  });

  it("reports missing files and anchors with file:line", () => {
    expect(checkLinks({ files, scan: ["plans/gone.md"] })).toEqual([
      { file: "plans/gone.md", line: 3, target: "docs/missing.md", reason: "missing-file" },
      { file: "plans/gone.md", line: 4, target: "../docs/a.md#nope", reason: "missing-anchor" },
    ]);
  });

  it("reports links that escape the repository", () => {
    const escaping = new Map([["x.md", "[e](../../etc/passwd)\n"]]);
    expect(checkLinks({ files: escaping, scan: ["x.md"] })).toEqual([
      { file: "x.md", line: 1, target: "../../etc/passwd", reason: "outside-repo" },
    ]);
  });

  it("reports a scanned file that is not in the map", () => {
    expect(checkLinks({ files, scan: ["nope.md"] })).toEqual([
      { file: "nope.md", line: 1, target: "nope.md", reason: "unreadable" },
    ]);
  });
});
