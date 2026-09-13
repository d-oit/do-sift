import { z } from "zod";

/**
 * Budget arithmetic is pure and testable; reservation/settlement is atomic
 * in storage (Plan 002). Estimates are always rounded UP so we never
 * under-reserve.
 */
export const BudgetRequest = z.object({
  maxInputTokens: z.number().int().min(1),
  maxOutputTokens: z.number().int().min(1),
  maxSearchCalls: z.number().int().min(0),
  maxFetches: z.number().int().min(0),
  deadlineMs: z.number().int().min(1),
});
export type BudgetRequest = z.infer<typeof BudgetRequest>;

export const BudgetReservation = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  searchCalls: z.number().int().nonnegative(),
  fetches: z.number().int().nonnegative(),
  expiresAtMs: z.number(),
});
export type BudgetReservation = z.infer<typeof BudgetReservation>;

export function planReservation(
  request: BudgetRequest,
  estimatedInputTokens: number,
  nowMs: number,
): BudgetReservation {
  if (estimatedInputTokens > request.maxInputTokens) {
    throw new Error(
      `estimated input ${estimatedInputTokens} exceeds budget ${request.maxInputTokens}`,
    );
  }
  return {
    inputTokens: request.maxInputTokens,
    outputTokens: request.maxOutputTokens,
    searchCalls: request.maxSearchCalls,
    fetches: request.maxFetches,
    expiresAtMs: nowMs + request.deadlineMs,
  };
}

/** Reconcile actual usage against the reservation; overruns are reported, never hidden. */
export function reconcile(
  reservation: BudgetReservation,
  actual: { inputTokens: number; outputTokens: number },
): { overrun: boolean; deltaInput: number; deltaOutput: number } {
  const deltaInput = actual.inputTokens - reservation.inputTokens;
  const deltaOutput = actual.outputTokens - reservation.outputTokens;
  return { overrun: deltaInput > 0 || deltaOutput > 0, deltaInput, deltaOutput };
}
