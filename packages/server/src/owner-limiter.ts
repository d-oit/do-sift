/** Per-owner admission limits (ANS-04): sliding-window limiter keyed by the resolved owner id. */
import { type IncomingMessage, type ServerResponse } from "node:http";
import type { ResearchServerOptions } from "./server-contracts.js";
import { jsonError } from "./server-http.js";
import type { RequestCancellation } from "./server-http.js";
export interface OwnerLimits {
  maxConcurrentPerOwner: number;
  maxRequestsPerMinute: number;
}
export const DEFAULT_OWNER_LIMITS: OwnerLimits = {
  maxConcurrentPerOwner: 2,
  maxRequestsPerMinute: 30,
};
export type Admission = { release: () => void } | { retryAfterSec: number };
export class OwnerLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly limits: OwnerLimits,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(ownerId: string): Admission {
    const t = this.now();
    const recent = (this.starts.get(ownerId) ?? []).filter((ts) => t - ts < 60_000);
    this.starts.set(ownerId, recent);
    if (recent.length >= this.limits.maxRequestsPerMinute) {
      const oldest = recent[0] ?? t;
      return { retryAfterSec: Math.max(1, Math.ceil((oldest + 60_000 - t) / 1000)) };
    }
    const running = this.inFlight.get(ownerId) ?? 0;
    if (running >= this.limits.maxConcurrentPerOwner) return { retryAfterSec: 1 };
    recent.push(t);
    this.inFlight.set(ownerId, running + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const left = (this.inFlight.get(ownerId) ?? 1) - 1;
        if (left <= 0) this.inFlight.delete(ownerId);
        else this.inFlight.set(ownerId, left);
      },
    };
  }
}
export const limiters = new WeakMap<object, OwnerLimiter>();
export function admitOwner(
  options: ResearchServerOptions,
  ownerId: string,
  res: ServerResponse,
  cancellation: RequestCancellation,
  requestId: string,
  req: IncomingMessage,
): boolean {
  let limiter = limiters.get(options);
  if (limiter === undefined) {
    limiter = new OwnerLimiter(options.ownerLimits ?? DEFAULT_OWNER_LIMITS);
    limiters.set(options, limiter);
  }
  const admission = limiter.acquire(ownerId);
  if ("retryAfterSec" in admission) {
    res.setHeader("retry-after", String(admission.retryAfterSec));
    jsonError(res, 429, "too many requests for this owner", requestId, req);
    return false;
  }
  cancellation.addCleanup(admission.release);
  return true;
}
