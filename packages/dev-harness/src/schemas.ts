/**
 * dev-harness schemas (DSH-02): zod contracts for the workflow event log,
 * sensor results, and evidence receipts. Every string is length-capped and
 * every shape is exactOptionalPropertyTypes-safe (omit absent keys — never
 * write explicit undefined). Frozen interface: plans/008-dev-signal-harness.md.
 */
import { z } from "zod";

/** Outcome of one sensor execution — or a halt-skip. */
export const SensorStatus = z.enum(["pass", "fail", "error", "skipped"]);
export type SensorStatus = z.infer<typeof SensorStatus>;

/**
 * Named signal sets (upstream do-harness parity). Unknown names are usage
 * errors, never vacuous passes (INV-006).
 */
export const SignalSetName = z.enum(["feedback", "verification", "release"]);
export type SignalSetName = z.infer<typeof SignalSetName>;

/** Lowercase hex sha-256 digest, exactly as produced by sha256Hex. */
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/u, "expected 64 lowercase hex chars");

/** UTC timestamp in ISO-8601 "Z" form (as written by Date.toISOString()). */
const IsoUtc = z.string().datetime().max(64);

/** One append-only, hash-chained workflow event (one JSON line per event). */
export const WorkflowEvent = z.object({
  seq: z.number().int().min(1),
  atUtc: IsoUtc,
  kind: z.enum(["init", "sensor_result", "sensor_halted", "errors_cleared"]),
  actor: z.string().min(1).max(64),
  sensor: z.string().min(1).max(64).optional(),
  status: SensorStatus.optional(),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  durationMs: z.number().int().min(0).optional(),
  outputSha256: Hex64.optional(),
  outputTail: z.string().max(2000).optional(),
  detail: z.string().max(512).optional(),
  chainHash: Hex64,
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

/**
 * An event as passed to the store: `seq` and `chainHash` are assigned by
 * appendEvent, never by the caller.
 */
export const WorkflowEventBodySchema = WorkflowEvent.omit({ seq: true, chainHash: true });
export type WorkflowEventBody = z.infer<typeof WorkflowEventBodySchema>;

/** Per-sensor receipt fields; exitCode is schema-limited to 0 | 1 | 2. */
export const SensorResult = z.object({
  name: z.string().min(1).max(64),
  ok: z.boolean(),
  status: SensorStatus,
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  durationMs: z.number().int().min(0),
  outputSha256: Hex64.optional(),
  outputTail: z.string().max(2000).optional(),
  detail: z.string().max(512).optional(),
});
export type SensorResult = z.infer<typeof SensorResult>;

/** Evidence receipt: one per signal-set run, `.do-harness/evidence.<set>.json`. */
export const EvidenceReport = z.object({
  schemaVersion: z.literal(1),
  set: SignalSetName,
  startedAtUtc: IsoUtc,
  finishedAtUtc: IsoUtc,
  sensors: z.array(SensorResult),
  failed: z.array(z.string().min(1).max(64)),
  verdict: z.enum(["green", "red"]),
});
export type EvidenceReport = z.infer<typeof EvidenceReport>;
