/**
 * dev-harness event store (DSH-02): append-only, hash-chained JSONL log at
 * `.do-harness/events.jsonl`. Documented hash contract (frozen in
 * plans/008-dev-signal-harness.md):
 *
 *   chainHash = sha256Hex( prevChainHash + "|" + canonicalJson(event minus chainHash) )
 *
 * `prevChainHash` is "" for the first event, and the event's `seq` IS part of
 * the hashed body (it is assigned before hashing). Reading validates the
 * schema, seq order, and chain linkage; any violation is state-corruption —
 * never silently ignored (INV-006 spirit). Dev scale: the store re-reads the
 * whole log on append instead of maintaining a head pointer.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEvent, WorkflowEventBodySchema, type WorkflowEventBody } from "./schemas.js";

export type DevHarnessErrorKind = "usage" | "state-corruption" | "execution";

/**
 * Domain error. The CLI maps usage/state-corruption to exit code 2 and prints
 * the message (already prefixed "dev-harness: ") to stderr.
 */
export class DevHarnessError extends Error {
  readonly kind: DevHarnessErrorKind;

  constructor(kind: DevHarnessErrorKind, message: string) {
    super(`dev-harness: ${message}`);
    this.name = "DevHarnessError";
    this.kind = kind;
  }
}

/** File name of the event log inside the state dir. */
export const EVENTS_FILE = "events.jsonl";

/** Default state dir, relative to the repo root (gitignored). */
export const DEFAULT_STATE_DIR = ".do-harness";

/**
 * Deterministic JSON: object keys sorted recursively, undefined object values
 * dropped — so hash input is stable regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Lowercase hex sha-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function eventsFilePath(eventsDir: string): string {
  return join(eventsDir, EVENTS_FILE);
}

/**
 * Append one event: validates the body, assigns `seq` (last + 1, or 1) and
 * `chainHash`, then writes a single JSON line. Reads (and validates) the
 * existing log first to anchor the chain, so a corrupted log refuses the
 * append instead of building on a broken chain. The state dir is created on
 * demand.
 */
export async function appendEvent(
  eventsDir: string,
  rawBody: WorkflowEventBody,
): Promise<WorkflowEvent> {
  const prior = await readEvents(eventsDir);
  const last = prior[prior.length - 1];
  const prevChainHash = last?.chainHash ?? "";
  const seq = (last?.seq ?? 0) + 1;
  let body: WorkflowEventBody;
  try {
    body = WorkflowEventBodySchema.parse(rawBody);
  } catch (err) {
    throw new DevHarnessError(
      "usage",
      `invalid event body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Hash input = prev chain hash + "|" + the event minus chainHash (seq included).
  const hashInput = `${prevChainHash}|${canonicalJson({ ...body, seq })}`;
  const event: WorkflowEvent = { ...body, seq, chainHash: sha256Hex(hashInput) };
  await mkdir(eventsDir, { recursive: true });
  await appendFile(eventsFilePath(eventsDir), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

/**
 * Read and validate the full event log: per-line schema validation, seq
 * strictly increasing from 1, and chain linkage recomputed from the canonical
 * form. Any violation (tampered field, broken seq order, invalid JSON, blank
 * interior line) throws DevHarnessError("state-corruption") with the offending
 * line number. A missing file yields [].
 */
export async function readEvents(eventsDir: string): Promise<WorkflowEvent[]> {
  let raw: string;
  try {
    raw = await readFile(eventsFilePath(eventsDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new DevHarnessError(
      "execution",
      `cannot read ${eventsFilePath(eventsDir)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // tolerate our own trailing newline
  const events: WorkflowEvent[] = [];
  let prevChainHash = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `${eventsFilePath(eventsDir)}:${i + 1}`;
    if (line === undefined || line.trim().length === 0) {
      throw new DevHarnessError("state-corruption", `${where}: blank line in event log`);
    }
    let event: WorkflowEvent;
    try {
      event = WorkflowEvent.parse(JSON.parse(line));
    } catch (err) {
      throw new DevHarnessError(
        "state-corruption",
        `${where}: invalid event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (event.seq !== i + 1) {
      throw new DevHarnessError(
        "state-corruption",
        `${where}: expected seq ${i + 1}, found ${event.seq}`,
      );
    }
    const hashBody: Record<string, unknown> = { ...event };
    delete hashBody.chainHash;
    const expected = sha256Hex(`${prevChainHash}|${canonicalJson(hashBody)}`);
    if (event.chainHash !== expected) {
      throw new DevHarnessError(
        "state-corruption",
        `${where}: chain hash mismatch (expected ${expected}, got ${event.chainHash})`,
      );
    }
    prevChainHash = event.chainHash;
    events.push(event);
  }
  return events;
}
