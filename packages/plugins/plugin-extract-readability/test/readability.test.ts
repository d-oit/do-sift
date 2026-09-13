import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import extractorJson from "../plugin.json" with { type: "json" };
import {
  createReadabilityExtractor,
  type ExtractedPassage,
  type ReadabilityInstance,
} from "../src/index.js";

function activated(configOverrides: Record<string, unknown> = {}): ReadabilityInstance {
  const plugin = createReadabilityExtractor();
  plugin.activate({
    pluginName: "extract-readability",
    config: configOverrides,
    events: { emit: () => {} },
  } as unknown as Parameters<ReadabilityInstance["activate"]>[0]);
  return plugin;
}

const GOOD =
  "The libSQL storage engine supports FTS5 virtual tables, which power the keyword retrieval baseline for stored evidence passages.";
const GOOD2 =
  "Retrieval quality is measured against a held-out set before any ranking claim is made, according to the plan documents.";

describe("readability extraction", () => {
  it("keeps substantive paragraphs and returns them ok", () => {
    const plugin = activated();
    const out = plugin.extract([GOOD, GOOD2].join("\n\n"));
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.status === "ok")).toBe(true);
    expect(out[0]?.text).toContain("FTS5 virtual tables");
  });

  it("drops boilerplate, nav bars, bare URLs, junk, and short fragments", () => {
    const plugin = activated();
    const text = [
      "Menu Home Products Pricing About Contact Us Careers", // nav-ish short line
      "Home | Products | Pricing | About | Contact | Careers | Sign in", // separator bar
      "https://example.org/some/very/long/link/that/stands/alone/in/its/own/paragraph/block",
      "© 2026 Example Corp. All rights reserved. Privacy Policy | Terms of Service",
      "THIS ENTIRE PARAGRAPH IS SHOUTED IN ALL CAPS WHICH MAKES IT BOILERPLATE LIKE A BANNER",
      "too short",
      GOOD,
    ].join("\n\n");
    const out = plugin.extract(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toContain("FTS5");
  });

  it("drops duplicate blocks regardless of case", () => {
    const plugin = activated();
    const out = plugin.extract([GOOD, GOOD.toLowerCase()].join("\n\n"));
    expect(out).toHaveLength(1);
  });

  it("truncates long excerpts at sentence boundaries and marks them partial", () => {
    const plugin = activated({ maxExcerptLength: 120 });
    const first = "The libSQL storage engine supports FTS5 virtual tables for evidence."; // period at ~68 chars
    const long = `${first} ${GOOD}`;
    const out = plugin.extract(long);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("partial");
    expect(out[0]?.text.length).toBeLessThanOrEqual(120);
    expect(out[0]?.text.endsWith(".")).toBe(true); // sentence boundary, not mid-word
  });

  it("caps the number of passages", () => {
    const plugin = activated({ maxPassages: 3 });
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `${GOOD} variant ${i} with distinct words.`,
    );
    expect(plugin.extract(paragraphs.join("\n\n"))).toHaveLength(3);
  });

  it("returns empty for empty or boilerplate-only input", () => {
    const plugin = activated();
    expect(plugin.extract("")).toEqual([]);
    expect(plugin.extract("Menu\n\nCopyright\n\nSign in")).toEqual([]);
  });

  it("refuses to run before activation", () => {
    expect(() => createReadabilityExtractor().extract(GOOD)).toThrow(/not activated/);
  });
});

describe("zero-capability proof + kernel round-trip", () => {
  it("declares no capabilities (pure text processing)", () => {
    expect(extractorJson.capabilities).toEqual([]);
    expect(extractorJson.kind).toBe("extractor");
  });

  it("registers, activates, extracts, and deactivates via the kernel", async () => {
    const kernel = new Kernel("local");
    let instance: ReadabilityInstance | undefined;
    kernel.register(extractorJson, () => {
      instance = createReadabilityExtractor();
      return instance;
    });
    await kernel.activate("extract-readability");
    const out: ExtractedPassage[] | undefined = instance?.extract(GOOD);
    expect(out?.[0]?.status).toBe("ok");
    await kernel.deactivate("extract-readability");
    expect(() => instance?.extract(GOOD)).toThrow(/not activated/);
  });
});
