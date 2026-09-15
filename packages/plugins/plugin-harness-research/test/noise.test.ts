import { describe, expect, it } from "vitest";
import { classifyNoise } from "../src/index.js";

/**
 * Noise-class fixtures (SRC-12, store-with-flag). The positive shapes are
 * VERBATIM from the recorded QUAL runs' captured evidence — run-006's
 * case-06 nav-list and reference blocks, run-005's case-04 colon-lead-in
 * stub and case-05 bibliography block (see plans/003-004-src-ans.md
 * SRC-12). The negatives pin the designed precision-over-recall bias: a
 * false flag suppresses real evidence from the answer pool, a miss only
 * leaves a noisy block.
 */
describe("noise classification (SRC-12)", () => {
  // run-006 case-06, evidence 204a3ba4 (verbatim shape; answer prefix removed)
  const NAV_LIST =
    "List of tallest mountains in the Solar System List of mountain peaks by prominence " +
    "List of highest mountains on Earth Summits farthest from the Earth's center";
  // run-006 case-06, evidence 6c5d6554 (verbatim shape)
  const REFERENCE =
    'Horrell, Mark (January 27, 2016). "Chimborazo: the furthest mountain from the centre ' +
    'of the Earth". (www.markhorrell.com). Mark Horrell. Retrieved September 12, 2016.';
  // run-005 case-04 (verbatim shape)
  const COLON_STUB = "The main tenets of the Peace of Westphalia were:";

  it("flags the run-006 nav-list concatenation as nav-list", () => {
    expect(classifyNoise(NAV_LIST)).toBe("nav-list");
  });

  it("flags the run-006 reference entry as reference", () => {
    expect(classifyNoise(REFERENCE)).toBe("reference");
  });

  it("flags Retrieved-date, ISBN and doi bibliography shapes as reference", () => {
    expect(classifyNoise("Smith, J. A history of SQLite. Retrieved 12 September 2016.")).toBe(
      "reference",
    );
    expect(classifyNoise("Peace of Westphalia. ISBN 978-0-19-515628-8. OUP.")).toBe("reference");
    expect(classifyNoise("The treaty text. doi:10.2307/2141972. JSTOR.")).toBe("reference");
  });

  it("flags the run-005 colon-lead-in stub as stub", () => {
    expect(classifyNoise(COLON_STUB)).toBe("stub");
  });

  it("keeps legitimate prose unflagged", () => {
    // a single "List of" mention inside real prose is not a nav list
    expect(
      classifyNoise(
        "Wikipedia maintains a List of highest mountains on Earth, and that list is " +
          "the source most summaries cite. The list ranks peaks by elevation above sea level.",
      ),
    ).toBeUndefined();
    // a legitimate short fact-bearing sentence stays (the caption-stub
    // boundary case is deliberately NOT classified — segmentation work)
    expect(
      classifyNoise("Mount Everest is Earth's highest mountain above sea level."),
    ).toBeUndefined();
    // a colon INSIDE a sentence is prose; only a chunk ENDING in a colon
    // is a split lead-in
    expect(
      classifyNoise(
        "The treaty's terms were: mutual pardons, territorial exchanges, and a " +
          "standstill of hostilities while the congress negotiated.",
      ),
    ).toBeUndefined();
  });

  it("is total over empty and whitespace input", () => {
    expect(classifyNoise("")).toBeUndefined();
    expect(classifyNoise("   \n  ")).toBeUndefined();
  });
});
