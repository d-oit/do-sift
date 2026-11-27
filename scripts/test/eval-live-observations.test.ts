import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLiveEval } from "../eval-live.js";

/**
 * Plan 074 (issue #160, live QUAL): the live runner records producer
 * quote/conflict behavior per case as observation-only receipt data.
 * Runs the deterministic mock-provider path to a throwaway temp path —
 * no network, no spend, no repo artifact.
 */
describe("eval-live producer behavior observations (plan 074)", () => {
  it("records per-case producerBehavior without changing the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "do-sift-live-qual-"));
    const output = join(dir, "mock-run.json");
    const artifact = await runLiveEval({ ...process.env }, {
      "opt-in": true,
      "owner-approval": true,
      "mock-provider": true,
      "terms-accepted-at": "2026-11-27",
      "sources-entry": "plan-074-test",
      annotators: "plan-074-test",
      output,
    } as never);
    expect(artifact.passed).toBe(true);
    expect(artifact.caseMetadata.length).toBeGreaterThan(0);
    // The quote-exercising case exists in the corpus.
    expect(artifact.caseMetadata.some((c) => c.id === "live-case-09")).toBe(true);
    for (const c of artifact.caseMetadata) {
      expect(c.producerBehavior).toBeDefined();
      expect(typeof c.producerBehavior?.quotesEmitted).toBe("number");
      expect(typeof c.producerBehavior?.conflictFlagged).toBe("boolean");
    }
    // Fixture model emits neither quotes nor conflict flags — zeros, not gates.
    expect(
      artifact.caseMetadata.every(
        (c) =>
          c.producerBehavior?.quotesEmitted === 0 && c.producerBehavior?.conflictFlagged === false,
      ),
    ).toBe(true);
    // The artifact on disk carries the same observations.
    const onDisk = JSON.parse(readFileSync(output, "utf8")) as typeof artifact;
    expect(onDisk.caseMetadata[0]?.producerBehavior).toEqual(
      artifact.caseMetadata[0]?.producerBehavior,
    );
  }, 120000);
});
