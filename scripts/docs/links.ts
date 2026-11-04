/**
 * Markdown documentation link checker (issue #121, INV-009).
 *
 * Scans every maintained Markdown file (and `llms.txt`) for relative links
 * and fragment-only anchors, and verifies each one resolves to a file on
 * disk or a heading in the target document. Absolute `http(s)`/`mailto:`
 * links are not fetched — the check is offline and hermetic (ADR 0001).
 *
 * Design choices that keep the check honest:
 *
 *   - **Scope is explicit.** The scan set is the repository's documentation
 *     surface, not `node_modules`, `dist`, or generated dashboards. A scope
 *     that resolves to zero files is a failure (INV-006 spirit).
 *   - **Both link shapes are checked.** Inline `](target)` links and
 *     reference definitions `[label]: target`. Fenced code blocks and inline
 *     code spans are skipped so documentation that *shows* a broken link in
 *     a code sample does not fail the gate.
 *   - **Anchors are computed the way GitHub does it**: lowercase, strip
 *     punctuation, spaces → hyphens, em dashes dropped. Duplicate headings
 *     get `-1`, `-2` suffixes in order.
 *   - **No network.** A relative link is a path problem, not a fetch
 *     problem; checking it offline keeps the gate deterministic.
 */

export interface LinkFinding {
  /** Repository-relative path of the file containing the link. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The target exactly as written (without `title`). */
  target: string;
  /** Why it failed. */
  reason: "missing-file" | "missing-anchor" | "outside-repo" | "unreadable";
}

export interface LinkCheckInput {
  /** Map of repo-relative path → file contents. */
  files: Map<string, string>;
  /** Files to scan (subset of `files` keys). */
  scan: readonly string[];
  /**
   * Extra existence check for non-document targets (images, generated HTML).
   * Without it, a target must be present in `files`; the sensor supplies a
   * filesystem-backed implementation so `evals/dashboard/index.html` can be
   * linked from `README.md` without loading it into the map.
   */
  exists?: ((path: string) => boolean) | undefined;
}

/** Fenced code block fences: ``` or ~~~ (three or more, optional language). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/** Markdown inline link: [text](target "optional title"). */
const INLINE_LINK = /\[(?:[^[\]\\]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'(][^)\n]*)?\s*\)/gu;

/** Reference definition: [label]: target */
const REFERENCE_DEF = /^ {0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/gmu;

/**
 * Strip fenced code blocks and inline code spans so examples that contain
 * deliberately-broken links are not treated as real links.
 */
export function stripCode(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (match) {
      const marker = match[1] ?? "";
      if (fence === undefined) {
        fence = marker[0] === "`" ? "`" : "~";
        out.push("");
        continue;
      }
      if (marker[0] === fence) {
        fence = undefined;
        out.push("");
        continue;
      }
    }
    if (fence !== undefined) {
      out.push("");
      continue;
    }
    // Blank out inline code spans, preserving line structure.
    out.push(line.replace(/`+[^`\n]*`+/gu, (span) => " ".repeat(span.length)));
  }
  return out.join("\n");
}

/**
 * GitHub-style heading anchors for one document. ATX headings only (`#`),
 * which is all this repository uses; a setext heading would need a lookahead
 * over the previous line.
 */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const raw of stripCode(markdown).split(/\r?\n/u)) {
    const match = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(raw);
    if (!match) continue;
    const slug = slugify(match[2] ?? "");
    if (slug === "") continue;
    const prior = seen.get(slug);
    if (prior === undefined) {
      seen.set(slug, 0);
      anchors.add(slug);
    } else {
      const next = prior + 1;
      seen.set(slug, next);
      anchors.add(`${slug}-${next}`);
    }
  }
  return anchors;
}

/** GitHub heading slug: lowercase, drop punctuation, spaces → hyphens. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

interface RawLink {
  line: number;
  target: string;
}

/** Every relative link (not absolute) in one document, in source order. */
export function relativeLinks(markdown: string): RawLink[] {
  const text = stripCode(markdown);
  const links: RawLink[] = [];
  const lineAt = (index: number): number => text.slice(0, index).split("\n").length;
  for (const match of text.matchAll(INLINE_LINK)) {
    const raw = (match[1] ?? "").replace(/^<|>$/gu, "");
    if (!isRelative(raw)) continue;
    links.push({ line: lineAt(match.index ?? 0), target: raw });
  }
  for (const match of text.matchAll(REFERENCE_DEF)) {
    const raw = (match[1] ?? "").replace(/^<|>$/gu, "");
    if (!isRelative(raw)) continue;
    links.push({ line: lineAt(match.index ?? 0), target: raw });
  }
  return links;
}

/** A link is "relative" when it is not a scheme, protocol-relative, or pure `#`. */
function isRelative(target: string): boolean {
  if (target === "") return false;
  if (target.startsWith("#")) return true; // same-document anchor
  if (target.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(target);
}

/** Resolve `target` against the directory of `fromPath` (repo-relative). */
export function resolveTarget(
  fromPath: string,
  target: string,
): { path: string; anchor?: string } | "outside-repo" {
  const hashIndex = target.indexOf("#");
  const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? undefined : target.slice(hashIndex + 1);
  // A query string is not part of a repository path.
  const queryIndex = beforeHash.indexOf("?");
  const rawPath = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const decoded = safeDecode(rawPath);

  const withAnchor = (path: string): { path: string; anchor?: string } =>
    anchor === undefined || anchor === "" ? { path } : { path, anchor };

  if (decoded === "") {
    // Pure fragment: same document.
    return withAnchor(fromPath);
  }

  const baseDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const segments = decoded.startsWith("/") ? [] : baseDir === "" ? [] : baseDir.split("/");

  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return "outside-repo";
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return withAnchor(segments.join("/"));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Check every relative link in the scan set. Findings are sorted for stable output. */
export function checkLinks(input: LinkCheckInput): LinkFinding[] {
  const findings: LinkFinding[] = [];
  const anchorCache = new Map<string, Set<string>>();

  for (const file of input.scan) {
    const contents = input.files.get(file);
    if (contents === undefined) {
      findings.push({ file, line: 1, target: file, reason: "unreadable" });
      continue;
    }
    for (const link of relativeLinks(contents)) {
      const resolved = resolveTarget(file, link.target);
      if (resolved === "outside-repo") {
        findings.push({ file, line: link.line, target: link.target, reason: "outside-repo" });
        continue;
      }
      const targetContents = input.files.get(resolved.path);
      const exists = targetContents !== undefined || (input.exists?.(resolved.path) ?? false);
      if (!exists) {
        findings.push({ file, line: link.line, target: link.target, reason: "missing-file" });
        continue;
      }
      if (resolved.anchor === undefined || resolved.anchor === "") continue;
      // An anchor can only be checked when the target's text is in the map.
      if (targetContents === undefined) continue;
      let anchors = anchorCache.get(resolved.path);
      if (anchors === undefined) {
        anchors = headingAnchors(targetContents);
        anchorCache.set(resolved.path, anchors);
      }
      const wanted = safeDecode(resolved.anchor).toLowerCase();
      if (!anchors.has(wanted)) {
        findings.push({ file, line: link.line, target: link.target, reason: "missing-anchor" });
      }
    }
  }

  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.target.localeCompare(b.target),
  );
}
