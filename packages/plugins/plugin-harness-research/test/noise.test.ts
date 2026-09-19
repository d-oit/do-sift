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

/**
 * Segmentation-fragment classification (SRC-18, the SRC-12 residual). The
 * positive shapes are VERBATIM from run-008 and run-009 case-07 — the four
 * zkp.science chunk shapes the raw-HTML conversion path emitted as
 * standalone passages and that reached the answer pool twice (see
 * evals/quality/run-009-2026-09-16.json case-07 notes). Same
 * precision-over-recall bias as SRC-12; the caption-stub and mid-formula
 * boundary stays deliberately unclassified.
 */
describe("fragment classification (SRC-18)", () => {
  // run-008/009 case-07, evidence 13b17672 (verbatim shape)
  const BULLET_ITEM = "- Academic C++ library for IOP-based zk-SNARKs.";
  // run-008/009 case-07, evidence 0f58b820 (verbatim shape; truncated link title)
  const TRUNCATED = "Vitalik Buterin’s introduction to SNARKs, part";
  // run-008/009 case-07, evidence d9624aca (verbatim shape; page <title>)
  const PIPE_TITLE = "What is a zero-knowledge proof? | Zero-Knowledge Proofs";
  // run-008/009 case-07, evidence 43f5db89 (verbatim shape; hero tagline)
  const BARE_QUESTION = "What are they, how do they work, and are they fast yet?";

  it("flags the run-008/009 bullet-item chunk as fragment", () => {
    expect(classifyNoise(BULLET_ITEM)).toBe("fragment");
  });

  it("flags the run-008/009 truncated link-title chunk as fragment", () => {
    expect(classifyNoise(TRUNCATED)).toBe("fragment");
  });

  it("flags the run-008/009 pipe-separated page-title chunk as fragment", () => {
    expect(classifyNoise(PIPE_TITLE)).toBe("fragment");
  });

  it("flags the run-008/009 standalone pure-question chunk as fragment", () => {
    expect(classifyNoise(BARE_QUESTION)).toBe("fragment");
  });

  it("flags the same shapes beyond the verbatim lengths while short", () => {
    expect(classifyNoise("- Another entry from the same converted link list.")).toBe("fragment");
    expect(classifyNoise("Site header | Site name")).toBe("fragment");
    expect(classifyNoise("A heading cut off mid")).toBeUndefined(); // ends on a noun, kept
    expect(classifyNoise("Notes on the design of")).toBe("fragment"); // ends on "of", unpunctuated
    expect(classifyNoise("Is this the fast path?")).toBe("fragment");
  });

  it("keeps legitimate prose unflagged (precision guards)", () => {
    // a longer bullet-item chunk may be self-contained list prose — the
    // length cap keeps it (disclosed boundary)
    expect(
      classifyNoise(
        "- The library ships with a proof assistant integration, a benchmarking " +
          "suite, and documentation that covers the standard IOP-based constructions " +
          "used across the research literature, which makes it usable for real work.",
      ),
    ).toBeUndefined();
    // a long pipe occurrence is table-ish content, not a page title
    expect(
      classifyNoise(
        "The comparison table lists the treaty provisions | signatories | ratification " +
          "dates across the three concurrent instruments negotiated at Osnabrück and Münster.",
      ),
    ).toBeUndefined();
    // real prose ends with terminal punctuation even when the last word
    // is a stopword
    expect(classifyNoise("The congress debated where the envoys would sit.")).toBeUndefined();
    expect(classifyNoise("This is the baseline the design builds on.")).toBeUndefined();
    // a question INSIDE prose (multi-sentence chunk, terminal period) is
    // content, not chrome
    expect(
      classifyNoise(
        "Why does the distinction matter? Because the succinctness bound is what makes " +
          "verification cheaper than the proof itself.",
      ),
    ).toBeUndefined();
    // the caption-stub and mid-formula boundary stays deliberately
    // unclassified (SRC-12 disclosure unchanged)
    expect(classifyNoise("Table 1: treaty signatories by power.")).toBeUndefined();
    expect(
      classifyNoise("E = mc^2 describes the rest energy of a body with mass m."),
    ).toBeUndefined();
    // a question longer than the cap is treated as content
    expect(
      classifyNoise(
        "What are the zero-knowledge succinct non-interactive arguments of knowledge, and how " +
          "do their proving and verification costs compare with the interactive originals?",
      ),
    ).toBeUndefined();
  });
});

/**
 * SRC-21 spike-adopted rules (2026-09-19 spike, 2 live fetches, exit 0):
 * shapes measured against the FULL live passage sets of the two
 * residual-producing pages (zkp.science, darksi.de) with 0/20
 * false positives on annotated-clean blocks. The REJECTS are pinned too:
 * verb-initial marketing lines and mid-formula fragments stay
 * unclassified (text-indistinguishable — the SRC-12 disclosure).
 */
describe("SRC-21 spike-adopted and spike-rejected shapes", () => {
  // verbatim spike hits — zkp.science bibliography set (R1 -> reference)
  it("flags trailing bracketed-citation entries as reference", () => {
    expect(classifyNoise("“SNARK” terminology and characterization of existence [BCCT11]")).toBe(
      "reference",
    );
    expect(classifyNoise("Zero-Knowledge Proofs [GMR85]")).toBe("reference");
    expect(classifyNoise("Succinct Non-Interactive ZK [M94]")).toBe("reference");
  });

  // verbatim spike hits — darksi.de code-blog shards (R2/R3 -> fragment)
  it("flags leading code-comment shards as fragment", () => {
    expect(classifyNoise("-- Output: 'hello world'")).toBe("fragment");
    expect(classifyNoise('-- (e.g. after ".load signal-fts5-extension.dylib")')).toBe("fragment");
    expect(classifyNoise("// see the docs for the extension API")).toBe("fragment");
  });

  it("flags leading-lowercase mid-sentence shards as fragment", () => {
    expect(
      classifyNoise(
        "that provides better support for non-latin languages (Chinese, Japanese, etc) in the Full-Text Search (FTS) via the unicode61 tokenizer",
      ),
    ).toBe("fragment");
    expect(classifyNoise("open-sourced a SQLite extension")).toBe("fragment");
    expect(classifyNoise("covered by the official documentation")).toBe("fragment");
    // the accepted cost: a lowercase-starting complete clause is also
    // flagged (a mid-sentence shard by construction)
    expect(classifyNoise("so we won't be discussing them much more here.")).toBe("fragment");
  });

  it("keeps spike-verified clean prose unflagged (0/20 guard set)", () => {
    // ends with a bracketed WORD IN PROSE, not a citation marker
    expect(
      classifyNoise(
        "What has been established by this treaty [of Westphalia], with the mutual " +
          "agreement of the parties, concerning certain disputed articles, stands firm.",
      ),
    ).toBeUndefined();
    // capital-start prose with interior colons/questions is content
    expect(
      classifyNoise(
        "Completeness: if the statement is true, then an honest verifier (that is, one " +
          "following the protocol) will accept the statement.",
      ),
    ).toBeUndefined();
    expect(
      classifyNoise(
        "No resulting rows! The reason for that is that the default tokenizer first splits the input.",
      ),
    ).toBeUndefined();
    expect(
      classifyNoise(
        "Since FTS5 only supports indexed searches by the start of the term - it cannot find terms in the middle.",
      ),
    ).toBeUndefined();
  });

  it("keeps the spike-REJECTED classes unclassified (disclosed, not fixed)", () => {
    // verb-initial marketing line: a complete sentence indistinguishable
    // from content prose (R4: 0 matches even on its target page)
    expect(
      classifyNoise(
        "Enables zkSNARK computations of up to billions of logical gates (100x larger than prior art) at a cost of milliseconds.",
      ),
    ).toBeUndefined();
    // mid-formula fragment (the SRC-12 disclosure stands)
    expect(
      classifyNoise(
        "(x,z)] is a record of the interactions between P(x) and V(x,z). The prover P is modeled as having unbounded power.",
      ),
    ).toBeUndefined();
  });
});
