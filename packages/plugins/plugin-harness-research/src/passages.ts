/** Passage extraction and noise classification for the research harness (SRC-12). */
import { type PassageNoiseClass } from "@do-sift/storage";
export const MAX_PASSAGES_PER_DOC = 20;
export const MAX_EXCERPT = 8192;
export const MIN_EXCERPT = 20;
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("research aborted", "AbortError");
  }
}
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
export function extractPassages(text: string): string[] {
  return text
    .split(/\r?\n\r?\n+/u)
    .map((p) => p.replace(/\s+/gu, " ").trim())
    .filter((p) => p.length >= MIN_EXCERPT)
    .slice(0, MAX_PASSAGES_PER_DOC)
    .map((p) => p.slice(0, MAX_EXCERPT));
}
export function classifyNoise(text: string): PassageNoiseClass | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // nav-list: a run of concatenated list-entry titles (the run-006
  // case-06 shape — "List of … List of … List of …"), not prose.
  const listLeads = trimmed.match(/\bList of\b/gu)?.length ?? 0;
  if (listLeads >= 3) return "nav-list";
  // reference: bibliography/citation markers (run-005 case-05, run-006
  // case-06 shapes — "Retrieved <date>", doi:, ISBN).
  if (
    /\bRetrieved\s+[A-Z][a-z]+\s+\d{1,2}\b/u.test(trimmed) ||
    /\bRetrieved\s+\d{1,2}\s+[A-Z][a-z]+\b/u.test(trimmed) ||
    /\bdoi:\s?\S/u.test(trimmed) ||
    /\bISBN\b/u.test(trimmed)
  ) {
    return "reference";
  }
  // stub: a chunk ENDING in a colon is a list lead-in whose list content
  // was split away (the run-005 case-04 shape) — not self-contained prose.
  if (trimmed.endsWith(":")) return "stub";
  // reference (SRC-21): a chunk ENDING in a bracketed citation marker
  // ("[BCCT11]", "[GMR85]" — the run-010/011 zkp.science bibliography
  // heading class) is a bibliography/nav entry, not prose. Spike-verified
  // against the page's full passage set: 4/4 of the residual set matched,
  // 0/20 clean-block false positives.
  if (/\[[A-Za-z]?[A-Z0-9]{2,12}[0-9]{0,4}\]\s*$/u.test(trimmed)) return "reference";
  // fragment (SRC-18 + SRC-21): segmentation fragments from the raw-HTML
  // conversion path. Each rule is a length-capped or shape-capped pattern
  // a legitimate chunk essentially never takes: a leading bullet mark
  // (converted list item), a two-part pipe split (the page <title>), an
  // unpunctuated truncation ending on a stopword/"part" (a cut-off link
  // title), or a standalone single question (hero/tagline chrome). SRC-21
  // added (spike-verified, 0/20 false positives): a leading code-comment
  // shard ("-- …" / "// …", the darksi.de class) and a leading-lowercase
  // mid-sentence shard (paragraph starts are capitalized in real prose;
  // the cost — losing a lowercase-starting content shard — is bounded and
  // recorded). Terminal punctuation or interior sentences keep real prose
  // unflagged; verb-initial marketing lines and mid-formula fragments stay
  // deliberately UNCLASSIFIED (text-indistinguishable from content — the
  // SRC-12 disclosure, re-affirmed by the SRC-21 spike).
  if (trimmed.startsWith("- ") && trimmed.length <= 200) return "fragment";
  if (trimmed.length <= 120 && /^[^|]+\|[^|]+$/u.test(trimmed)) return "fragment";
  if (
    trimmed.length <= 120 &&
    !/[.!?…]["'”’)\]]?$/u.test(trimmed) &&
    /\b(of|and|the|in|for|with|on|to|by|from|at|part)$/iu.test(trimmed)
  ) {
    return "fragment";
  }
  if (trimmed.length <= 100 && trimmed.endsWith("?") && !/[.!?]/u.test(trimmed.slice(0, -1))) {
    return "fragment";
  }
  if (/^(--|\/\/)\s*\S/u.test(trimmed)) return "fragment";
  if (/^[a-z]/u.test(trimmed)) return "fragment";
  return undefined;
}
export function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}
export function hostOf(url: string): string {
  return new URL(url).hostname;
}
