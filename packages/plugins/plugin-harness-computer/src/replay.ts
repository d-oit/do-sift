/**
 * Replay (CMP-02, plan 006). Re-executes a recorded computer-harness run
 * against a driver — for audit, debugging, and reproducing a session.
 *
 * The recorded log is the CONSENT AUTHORITY: allowed actions re-execute,
 * denied actions are skipped (never re-attempted, never re-prompted — no
 * ConsentPrompt exists in replay). The plan is matched against the log
 * entry-by-entry (same length, same action kinds in order); any mismatch
 * is refused as tampering, so a plan cannot smuggle in actions the
 * recorded run never performed or never asked for.
 *
 * Replay itself has no side channels: it drives only the injected driver,
 * and this module adds no listener, server, or remote surface of any kind.
 */
import type { HarnessRunLog } from "@do-sift/contracts";
import type { ComputerActionPlan, DesktopDriver } from "./index.js";

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export interface ReplayComputerRunOptions {
  log: HarnessRunLog;
  plan: ComputerActionPlan;
  driver: DesktopDriver;
}

export interface ReplayOutcome {
  /** Number of recorded-allowed actions re-executed against the driver. */
  executed: number;
  /** Recorded-denied actions skipped (never re-attempted). */
  skipped: number;
  /** Mirrors the original run's outcome. */
  outcome: HarnessRunLog["outcome"];
}

function describeStep(step: ComputerActionPlan["actions"][number]): string {
  switch (step.kind) {
    case "open":
      return step.target;
    case "type":
      return `${step.text.length} chars`;
    case "click":
      return step.target;
    case "scroll":
      return `${step.px}px`;
    case "key":
      return step.combo;
  }
}

async function executeStep(
  driver: DesktopDriver,
  step: ComputerActionPlan["actions"][number],
): Promise<void> {
  switch (step.kind) {
    case "open":
      await driver.open(step.target);
      return;
    case "type":
      await driver.type(step.text, 0); // audit replay: no per-keystroke delay
      return;
    case "click":
      await driver.click(step.target);
      return;
    case "scroll":
      await driver.scroll(step.px);
      return;
    case "key":
      await driver.key(step.combo);
      return;
  }
}

/**
 * Replay a recorded run. Throws ReplayError when the plan does not match
 * the log exactly (same action count, same kinds in the same order).
 */
export async function replayComputerRun(options: ReplayComputerRunOptions): Promise<ReplayOutcome> {
  const { log, plan, driver } = options;
  if (plan.actions.length !== log.actions.length) {
    throw new ReplayError(
      `plan/log mismatch: plan has ${plan.actions.length} actions, log records ${log.actions.length}`,
    );
  }
  for (let i = 0; i < plan.actions.length; i++) {
    const step = plan.actions[i];
    const recorded = log.actions[i];
    if (step === undefined || recorded === undefined) {
      throw new ReplayError(`plan/log mismatch at action ${i}`);
    }
    if (step.kind !== recorded.type) {
      throw new ReplayError(
        `plan/log mismatch at action ${i}: plan has "${step.kind}" (${describeStep(step)}), log records "${recorded.type}" (${recorded.detail})`,
      );
    }
  }

  let executed = 0;
  let skipped = 0;
  for (let i = 0; i < plan.actions.length; i++) {
    const step = plan.actions[i];
    const recorded = log.actions[i];
    if (step === undefined || recorded === undefined) break;
    if (!recorded.allowed) {
      skipped++; // consent authority: denied stays denied
      continue;
    }
    await executeStep(driver, step);
    executed++;
  }
  return { executed, skipped, outcome: log.outcome };
}
