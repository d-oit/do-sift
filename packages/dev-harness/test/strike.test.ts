/**
 * dev-harness strike/halt tests (DSH-02): pure state machine over ordered
 * events — no fs, no spawned processes. Frozen behavior: HALT_THRESHOLD
 * consecutive failures halt a sensor; a pass resets the streak; `errors
 * clear` (named or all) lifts it; `sensor_halted` leaves it unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  HALT_THRESHOLD,
  strikeState,
  type SensorStatus,
  type WorkflowEvent,
} from "../src/index.js";

const ISO = "2026-01-01T00:00:00.000Z";
const CHAIN = "a".repeat(64);

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function result(sensor: string, status: SensorStatus): WorkflowEvent {
  return {
    seq: nextSeq(),
    atUtc: ISO,
    kind: "sensor_result",
    actor: "test",
    sensor,
    status,
    chainHash: CHAIN,
  };
}

function halted(sensor: string): WorkflowEvent {
  return {
    seq: nextSeq(),
    atUtc: ISO,
    kind: "sensor_halted",
    actor: "test",
    sensor,
    chainHash: CHAIN,
  };
}

function cleared(sensor?: string): WorkflowEvent {
  return {
    seq: nextSeq(),
    atUtc: ISO,
    kind: "errors_cleared",
    actor: "test",
    ...(sensor === undefined ? {} : { sensor }),
    chainHash: CHAIN,
  };
}

describe("strikeState", () => {
  it("returns an empty map for an empty log", () => {
    expect(strikeState([]).size).toBe(0);
  });

  it("halts a sensor at HALT_THRESHOLD consecutive failures", () => {
    const state = strikeState([
      result("format", "fail"),
      result("format", "fail"),
      result("format", "fail"),
    ]);
    expect(state.get("format")).toEqual({ consecutive: HALT_THRESHOLD, halted: true });
  });

  it("does not halt below the threshold", () => {
    const state = strikeState([result("format", "fail"), result("format", "fail")]);
    expect(state.get("format")).toEqual({ consecutive: 2, halted: false });
  });

  it("counts error results as failures too", () => {
    const state = strikeState([
      result("lint", "fail"),
      result("lint", "error"),
      result("lint", "error"),
    ]);
    expect(state.get("lint")).toEqual({ consecutive: 3, halted: true });
  });

  it("resets the streak on a passing run", () => {
    const state = strikeState([
      result("format", "fail"),
      result("format", "fail"),
      result("format", "pass"),
    ]);
    expect(state.get("format")).toEqual({ consecutive: 0, halted: false });
  });

  it("tracks sensors independently", () => {
    const state = strikeState([
      result("format", "fail"),
      result("lint", "fail"),
      result("format", "fail"),
    ]);
    expect(state.get("format")).toEqual({ consecutive: 2, halted: false });
    expect(state.get("lint")).toEqual({ consecutive: 1, halted: false });
  });

  it("errors_cleared for a named sensor resets only that sensor", () => {
    const state = strikeState([
      result("format", "fail"),
      result("format", "fail"),
      result("format", "fail"),
      result("lint", "fail"),
      cleared("format"),
    ]);
    expect(state.get("format")).toEqual({ consecutive: 0, halted: false });
    expect(state.get("lint")).toEqual({ consecutive: 1, halted: false });
  });

  it("errors_cleared with no sensor resets all sensors", () => {
    const state = strikeState([
      result("format", "fail"),
      result("format", "fail"),
      result("format", "fail"),
      result("lint", "error"),
      cleared(),
    ]);
    expect(state.get("format")).toEqual({ consecutive: 0, halted: false });
    expect(state.get("lint")).toEqual({ consecutive: 0, halted: false });
  });

  it("sensor_halted leaves the strike state unchanged", () => {
    const state = strikeState([
      result("format", "fail"),
      result("format", "fail"),
      result("format", "fail"),
      halted("format"),
    ]);
    expect(state.get("format")).toEqual({ consecutive: 3, halted: true });
  });

  it("a skipped sensor_result leaves the streak unchanged", () => {
    const state = strikeState([
      result("format", "fail"),
      result("format", "fail"),
      result("format", "skipped"),
    ]);
    expect(state.get("format")).toEqual({ consecutive: 2, halted: false });
  });

  it("records sensors seen only in sensor_halted events", () => {
    const state = strikeState([halted("format")]);
    expect(state.get("format")).toEqual({ consecutive: 0, halted: false });
  });

  it("ignores events without a sensor", () => {
    const state = strikeState([
      {
        seq: nextSeq(),
        atUtc: ISO,
        kind: "sensor_result",
        actor: "test",
        status: "fail",
        chainHash: CHAIN,
      },
    ]);
    expect(state.size).toBe(0);
  });
});
