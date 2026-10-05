/**
 * QF-02: poisoned model-cache handling. A failed/partial model download
 * (e.g. a proxy error body saved as the model archive) must be detectable
 * and removable so the next init can re-download — without touching
 * extracted model dirs or unrelated files.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearModelDownloadArtifacts } from "../src/fastembed-embedder.js";

describe("clearModelDownloadArtifacts (QF-02)", () => {
  it("removes only downloaded archives; keeps extracted models and unrelated files", () => {
    const dir = mkdtempSync(join(tmpdir(), "qf02-cache-"));
    writeFileSync(join(dir, "fast-bge-small-en-v1.5.tar.gz"), "poison");
    writeFileSync(join(dir, "other-model.tar.gz"), "poison");
    mkdirSync(join(dir, "fast-bge-small-en-v1.5")); // extracted model dir
    writeFileSync(join(dir, "notes.txt"), "keep");

    const removed = clearModelDownloadArtifacts(dir).sort();

    expect(removed).toEqual(
      [join(dir, "fast-bge-small-en-v1.5.tar.gz"), join(dir, "other-model.tar.gz")].sort(),
    );
    expect(existsSync(join(dir, "fast-bge-small-en-v1.5.tar.gz"))).toBe(false);
    expect(existsSync(join(dir, "other-model.tar.gz"))).toBe(false);
    expect(existsSync(join(dir, "fast-bge-small-en-v1.5"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("returns [] for a missing cache dir instead of throwing", () => {
    expect(clearModelDownloadArtifacts(join(tmpdir(), "qf02-missing-dir-xyz"))).toEqual([]);
  });
});
