/**
 * Evidence-framing primitives (ANS-10, plan 013, R-12). Pure string
 * functions over UNTRUSTED passage text: neutralize → frame → detect.
 *
 * Threat model (plan 013): passage text is attacker-influenceable and is
 * packed into the model prompt. Three deterministic layers, zero model
 * calls:
 *
 * 1. `neutralizeEvidenceText` — structural neutralization. Collapses every
 *    control/format/line-separator char so passage text cannot forge the
 *    prompt's LINE structure (one passage per line) or carry bidi/zero-width
 *    deception (Trojan Source class). Content characters are preserved —
 *    this is not censorship; the citation gate still judges every block.
 * 2. `frameEvidenceLine` — the unforgeable framing primitive. One JSON
 *    object per line: JSON escaping forbids unescaped `"`/`\`, and the
 *    newline precondition (set by neutralization) forbids new lines, so a
 *    passage cannot terminate its own record or mint another one. Callers
 *    MUST neutralize first — the precondition is enforced, not trusted.
 * 3. `suspectEvidenceMarkers` — advisory detector over RAW stored text.
 *    Returns stable marker codes for receipts/monitoring (the measurability
 *    layer for the QUAL gate); it NEVER degrades an answer by itself and is
 *    precision-loose by design (a miss leaves one noisy block; the classify
 *    Noise disclosure pattern, SRC-12).
 *
 * Deterministic and offline: same input, same output, no I/O.
 */

export type EvidenceMarker =
  | "control-chars"
  | "evidence-line-shape"
  | "framing-mimicry"
  | "instruction-override"
  | "invisible-chars"
  | "role-mimicry";

export class EvidenceFramingError extends Error {
  constructor(message: string) {
    super(`evidence-framing: ${message}`);
    this.name = "EvidenceFramingError";
  }
}

/**
 * Structural neutralization of untrusted passage text: delete Unicode
 * format chars (bidi marks/overrides, zero-width, BOM — `\p{Cf}`), map
 * control chars and line/paragraph separators (`\p{Cc}`, `\p{Zl}`,
 * `\p{Zp}`) to a single space, collapse whitespace runs, trim. The result
 * is one line with no invisible-reordering characters; ordinary content
 * characters pass through byte-for-byte.
 */
export function neutralizeEvidenceText(text: string): string {
  return text
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * One JSON-serialized evidence record per call: `{"id":"…","text":"…"}`.
 * The line-integrity precondition is ENFORCED (a caller that skipped
 * neutralization throws instead of shipping a forgeable frame), and the id
 * must satisfy the EvidenceId contract.
 */
export function frameEvidenceLine(id: string, neutralizedText: string): string {
  if (/[\n\r\u2028\u2029\u0085]/u.test(neutralizedText)) {
    throw new EvidenceFramingError(
      "text carries a line separator — neutralize it first (one JSON record per line is the forgery bound)",
    );
  }
  if (!/^[^\s]{1,128}$/u.test(id)) {
    throw new EvidenceFramingError(
      "id must be 1..128 chars with no whitespace (EvidenceId contract)",
    );
  }
  return JSON.stringify({ id, text: neutralizedText });
}

/**
 * Advisory suspect markers over RAW (un-neutralized) text. Stable codes:
 *
 * - `role-mimicry` — a line starting `system:`/`assistant:`/`user:`/
 *   `tool:`/`developer:` (chat-template impersonation)
 * - `framing-mimicry` — a line starting `Question:`/`Evidence:`/
 *   `Follow-up context:` (our own prompt structure)
 * - `evidence-line-shape` — a line starting `[id] ` (our own packing shape)
 * - `instruction-override` — ignore/disregard/forget/override + an
 *   above/previous qualifier within the same sentence
 * - `invisible-chars` — Unicode format chars (`\p{Cf}`: bidi, zero-width)
 * - `control-chars` — anomalous control chars, EXCLUDING benign whitespace
 *   controls (\t\n\r\f\v are legitimate in raw page text)
 *
 * Returns each matching marker once, sorted. Deliberately loose (advisory
 * receipts, not a filter): a page that opens a line with a bracketed term
 * flags; that is the recorded trade-off.
 */
const MARKERS: ReadonlyArray<readonly [EvidenceMarker, RegExp]> = [
  ["role-mimicry", /(?:^|[\r\n])[ \t]*(?:system|assistant|user|tool|developer)[ \t]*:/imu],
  ["framing-mimicry", /(?:^|[\r\n])[ \t]*(?:question|evidence|follow-up context)[ \t]*:/imu],
  ["evidence-line-shape", /(?:^|[\r\n])[ \t]*\[[^\][\r\n]{1,128}\][ \t]/u],
  [
    "instruction-override",
    /\b(?:ignore|disregard|forget|override)\b[^.\r\n]{0,60}\b(?:above|previous|prior|earlier)\b/iu,
  ],
  ["invisible-chars", /\p{Cf}/u],
];

export function suspectEvidenceMarkers(text: string): EvidenceMarker[] {
  const withoutBenignWhitespace = text.replace(/[\t\n\r\f\v]/gu, "");
  const found: EvidenceMarker[] = [];
  for (const [marker, pattern] of MARKERS) {
    if (pattern.test(text)) found.push(marker);
  }
  // the control-char rule runs on the benign-whitespace-stripped copy
  if (/\p{Cc}/u.test(withoutBenignWhitespace)) found.push("control-chars");
  return [...new Set(found)].sort();
}
