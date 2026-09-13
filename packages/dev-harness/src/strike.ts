/**
 * dev-harness strike/halt state (DSH-02): pure computation over the ordered
 * event log — no fs, fully table-testable. HALT_THRESHOLD consecutive failing
 * runs of one sensor halt it (it is skipped and reported failed, with a halt
 * diagnostic) until an explicit `errors clear`; a passing run resets the
 * streak. plans/008-dev-signal-harness.md, ADR 0007.
 */
import type { WorkflowEvent } from "./schemas.js";

/** Consecutive failing runs after which a sensor is halted. */
export const HALT_THRESHOLD = 3;

/**
 * Per-sensor strike state, in event-log order:
 * - `sensor_result` with status pass → streak 0; fail/error → streak + 1;
 *   skipped (or no status) → unchanged.
 * - `errors_cleared` naming that sensor — or no sensor at all (clear-all) →
 *   streak 0.
 * - `sensor_halted` → unchanged (it only records that a halt was reported).
 * - `init`, or results without a sensor name → ignored.
 * `halted` is true iff the streak is ≥ HALT_THRESHOLD.
 */
export function strikeState(
  events: readonly WorkflowEvent[],
): Map<string, { consecutive: number; halted: boolean }> {
  const strikes = new Map<string, { consecutive: number; halted: boolean }>();
  for (const event of events) {
    if (event.kind === "sensor_result" || event.kind === "sensor_halted") {
      if (event.sensor === undefined) continue; // unattributable; nothing to strike
      const entry = strikes.get(event.sensor) ?? { consecutive: 0, halted: false };
      if (event.kind === "sensor_halted") {
        strikes.set(event.sensor, entry); // record the sensor, leave the streak unchanged
        continue;
      }
      if (event.status === "pass") {
        entry.consecutive = 0;
      } else if (event.status === "fail" || event.status === "error") {
        entry.consecutive += 1;
      }
      entry.halted = entry.consecutive >= HALT_THRESHOLD;
      strikes.set(event.sensor, entry);
    } else if (event.kind === "errors_cleared") {
      if (event.sensor === undefined) {
        for (const entry of strikes.values()) {
          entry.consecutive = 0;
          entry.halted = false;
        }
      } else {
        strikes.set(event.sensor, { consecutive: 0, halted: false });
      }
    }
    // "init" events carry no per-sensor signal.
  }
  return strikes;
}
