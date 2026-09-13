import { z } from "zod";

/** Harness task = a bounded, policy-checked unit of work. Not free-form agency. */
export const HarnessTask = z.object({
  kind: z.enum(["research", "browser", "computer"]),
  ownerId: z.string().min(1).max(128),
  instruction: z.string().min(1).max(2048),
  limits: z.object({
    deadlineMs: z.number().int().min(1).max(300_000),
    maxActions: z.number().int().min(1).max(500),
  }),
});
export type HarnessTask = z.infer<typeof HarnessTask>;

export const HarnessAction = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string().min(1).max(64),
  detail: z.string().max(2048).default(""),
  allowed: z.boolean(),
  /** Present when `allowed` is false: which policy denied the action. */
  deniedBy: z.string().max(128).optional(),
});
export type HarnessAction = z.infer<typeof HarnessAction>;

export const HarnessRunLog = z.object({
  task: HarnessTask,
  actions: z.array(HarnessAction),
  outcome: z.enum(["completed", "denied", "failed", "timeout"]),
});
export type HarnessRunLog = z.infer<typeof HarnessRunLog>;

/** Harnesses receive typed tools, not raw power; every action is logged. */
export interface Harness {
  readonly name: string;
  run(task: HarnessTask, signal?: AbortSignal): Promise<HarnessRunLog>;
}
