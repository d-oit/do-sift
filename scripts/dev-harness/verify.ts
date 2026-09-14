/**
 * dev-harness run orchestrator (DSH-02): resolves a signal set, skips halted
 * sensors (one `sensor_halted` event plus a skipped SensorResult naming the
 * clear command), runs the remaining sensors sequentially with optional
 * fail-fast, appends one `sensor_result` event per executed sensor, and writes
 * an evidence receipt. The verdict is green only if nothing failed AND at
 * least one sensor executed — never a vacuous pass (INV-006). Strike state is
 * computed from prior events, so a sensor reaching HALT_THRESHOLD during this
 * run is halted on the next run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceReport, SignalSetName, type SensorResult, type WorkflowEvent } from "./schemas.js";
import { DEFAULT_STATE_DIR, DevHarnessError, appendEvent, readEvents } from "./store.js";
import { HALT_THRESHOLD, strikeState } from "./strike.js";
import {
  SENSOR_DEFS,
  resolveEntry,
  resolveSensor,
  runSensor,
  sensorNamesForSet,
  type SensorDef,
} from "./sensors.js";

export type RunSignalSetOptions = {
  /** Repo root; also the default parent of the state dir and the spawn cwd. */
  repoRoot: string;
  /** Signal set name; unknown names are usage errors (INV-006). */
  set: string;
  /** Who is running: "cli", "hook:pre-commit", or "hook:pre-push"; 1..64 chars. */
  actor: string;
  /** Stop after the first failing sensor; unrun sensors are simply absent. */
  failFast?: boolean;
  /** State dir override (default: <repoRoot>/.do-harness). */
  eventsDir?: string;
  /** Injectable UTC clock returning an ISO-8601 string (tests). */
  nowUtc?: () => string;
  /** Sensor registry override (tests); replaces SENSOR_DEFS entirely. */
  sensorOverrides?: readonly SensorDef[];
  /** Workspace fingerprint stamped on events and the receipt (DSH-07). */
  workspaceSha256?: string;
  /** Run a single sensor that must be a member of the set (DSH-08). */
  only?: string;
};

export type RunSignalSetResult = {
  report: EvidenceReport;
  /** The events appended by this run, in append order. */
  events: WorkflowEvent[];
  exitCode: 0 | 1 | 2;
};

function defaultNowUtc(): string {
  return new Date().toISOString();
}

export async function runSignalSet(options: RunSignalSetOptions): Promise<RunSignalSetResult> {
  const {
    repoRoot,
    set,
    actor,
    failFast = false,
    eventsDir,
    nowUtc = defaultNowUtc,
    sensorOverrides,
    workspaceSha256,
    only,
  } = options;

  const registry = sensorOverrides ?? SENSOR_DEFS;
  // The node_modules entrypoint guard applies to the built-in registry only:
  // synthetic defs (sensorOverrides, a test seam) use node flags such as "-e"
  // as argv[0], which are not file paths to stat.
  const guardEntrypoints = sensorOverrides === undefined;
  const dir = eventsDir ?? join(repoRoot, DEFAULT_STATE_DIR);
  if (actor.length === 0 || actor.length > 64) {
    throw new DevHarnessError("usage", `actor must be 1..64 characters, got ${actor.length}`);
  }
  const names = sensorNamesForSet(set, registry); // usage error on unknown/empty (INV-006)
  const setName = SignalSetName.parse(set); // cannot fail once names resolved
  let selected = names;
  if (only !== undefined) {
    // --only narrows the run to one member of the set (DSH-08); a non-member
    // is a usage error so receipts can never contain sensors outside their set.
    if (!names.includes(only)) {
      throw new DevHarnessError(
        "usage",
        `only: sensor "${only}" is not in set "${set}" (${names.join(", ")})`,
      );
    }
    selected = [only];
  }

  const prior = await readEvents(dir); // state-corruption propagates to the caller
  const strikes = strikeState(prior);
  const startedAtUtc = nowUtc();

  const results: SensorResult[] = [];
  const appended: WorkflowEvent[] = [];

  for (const name of selected) {
    if (strikes.get(name)?.halted === true) {
      const detail = `halted after ${HALT_THRESHOLD} consecutive failures — clear with: npm run signals -- errors clear --sensor ${name}`;
      // exitCode 2: the harness state (halt), not a sensor exit.
      results.push({ name, ok: false, status: "skipped", exitCode: 2, durationMs: 0, detail });
      appended.push(
        await appendEvent(dir, {
          kind: "sensor_halted",
          atUtc: nowUtc(),
          actor,
          sensor: name,
          detail,
        }),
      );
      continue;
    }
    const def = resolveSensor(name, registry);
    if (guardEntrypoints) resolveEntry(def); // missing entrypoint → usage error (check.ts parity)
    const run = runSensor(def, repoRoot);
    results.push({
      name: run.name,
      ok: run.ok,
      status: run.status,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      outputSha256: run.outputSha256,
      outputTail: run.outputTail,
      ...(run.detail === undefined ? {} : { detail: run.detail }),
    });
    appended.push(
      await appendEvent(dir, {
        kind: "sensor_result",
        atUtc: nowUtc(),
        actor,
        sensor: run.name,
        status: run.status,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        outputSha256: run.outputSha256,
        outputTail: run.outputTail,
        ...(run.detail === undefined ? {} : { detail: run.detail }),
        ...(workspaceSha256 === undefined ? {} : { workspaceSha256 }),
      }),
    );
    if (failFast && !run.ok) break;
  }

  const finishedAtUtc = nowUtc();
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  const executed = results.some((r) => r.status !== "skipped");
  const verdict = failed.length === 0 && executed ? "green" : "red";
  const report: EvidenceReport = {
    schemaVersion: 1,
    set: setName,
    startedAtUtc,
    finishedAtUtc,
    sensors: results,
    failed,
    verdict,
    ...(workspaceSha256 === undefined ? {} : { workspaceSha256 }),
  };
  await writeFile(
    join(dir, `evidence.${setName}.json`),
    `${JSON.stringify(EvidenceReport.parse(report), null, 2)}\n`,
    "utf8",
  );
  return { report, events: appended, exitCode: verdict === "green" ? 0 : 1 };
}
