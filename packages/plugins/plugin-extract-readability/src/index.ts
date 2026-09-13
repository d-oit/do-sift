/**
 * Readability extractor (SRC-03, plan 003). Turns fetched page text into
 * evidence-passage candidates. Pure function of its input: fetched text is
 * data, never instructions; nothing here fetches scripts or subresources,
 * touches the network, or reads files (zero capabilities by manifest).
 *
 * Heuristics are deterministic and conservative — a passage that might be
 * evidence is kept; obvious boilerplate is dropped. This is evidence
 * extraction, not quality judgment (ADR 0003: extraction status is
 * provenance, never a factual claim).
 */
import type { PluginInstance } from "@do-sift/kernel";

export interface ReadabilityConfig {
  minLength?: unknown;
  maxExcerptLength?: unknown;
  maxPassages?: unknown;
}

export interface ExtractedPassage {
  text: string;
  /** ok = intact excerpt; partial = truncated (never mid-word). */
  status: "ok" | "partial";
}

export interface ReadabilityInstance extends PluginInstance {
  extract(text: string): ExtractedPassage[];
}

export interface ReadabilityOptions {
  minLength: number;
  maxExcerptLength: number;
  maxPassages: number;
}

const DEFAULTS: ReadabilityOptions = { minLength: 40, maxExcerptLength: 8192, maxPassages: 20 };

/** Boilerplate/nav markers: conservative prefix/phrase list, case-insensitive. */
const BOILERPLATE =
  /^(?:menu|navigation|nav|skip to content|copyright|all rights reserved|cookie|cookies|privacy policy|terms of use|terms of service|subscribe|sign in|log in|share this|advertisement|sponsored|back to top|read more)\b/iu;

function isBoilerplate(line: string): boolean {
  if (line.startsWith("©") || line.startsWith("(c)")) return true;
  if (BOILERPLATE.test(line)) return true;
  if ((line.match(/\|/gu) ?? []).length >= 3) return true; // nav/link bars
  if (/^https?:\/\/\S+$/u.test(line)) return true; // bare URL
  if (/^[\W\d_]+$/u.test(line)) return true; // punctuation/digits only
  const letters = line.match(/\p{L}/gu) ?? [];
  if (letters.length >= 20) {
    const upper = (line.match(/\p{Lu}/gu) ?? []).length;
    if (upper / letters.length > 0.6) return true; // shout-all-caps block
  }
  return false;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function truncateAtSentence(text: string, limit: number): { text: string; partial: boolean } {
  if (text.length <= limit) return { text, partial: false };
  const window = text.slice(0, limit);
  const cut = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  // keep the sentence that ends within the window; +1 includes the punctuation
  const sliced =
    cut >= Math.floor(limit * 0.5) ? window.slice(0, cut + 1) : window.replace(/\s+\S*$/u, "");
  return { text: sliced.trimEnd(), partial: true };
}

export function createReadabilityExtractor(): ReadabilityInstance {
  let options = DEFAULTS;
  let activated = false;

  return {
    activate(context) {
      const cfg = context.config as ReadabilityConfig;
      options = {
        minLength: positiveInt(cfg.minLength, DEFAULTS.minLength),
        maxExcerptLength: positiveInt(cfg.maxExcerptLength, DEFAULTS.maxExcerptLength),
        maxPassages: positiveInt(cfg.maxPassages, DEFAULTS.maxPassages),
      };
      activated = true;
      context.events.emit("extract-readability.activated", { ...options });
    },

    async deactivate() {
      activated = false;
    },

    extract(text: string): ExtractedPassage[] {
      if (!activated) throw new Error("extract-readability is not activated");
      const seen = new Set<string>();
      const passages: ExtractedPassage[] = [];

      for (const rawBlock of text.split(/\r?\n\s*\r?\n+/u)) {
        if (passages.length >= options.maxPassages) break;
        const block = rawBlock.replace(/\s+/gu, " ").trim();
        if (block.length < options.minLength) continue;
        if (isBoilerplate(block)) continue;
        const key = block.toLowerCase();
        if (seen.has(key)) continue; // duplicate block
        seen.add(key);
        const { text: excerpt, partial } = truncateAtSentence(block, options.maxExcerptLength);
        passages.push({ text: excerpt, status: partial ? "partial" : "ok" });
      }
      return passages;
    },
  };
}
