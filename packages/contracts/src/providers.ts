/**
 * Provider intelligence registry (issue #171).
 *
 * Configuration, permission, availability, and health are **separate**
 * statuses. A provider is never assumed free because a price is missing; the
 * price renders as `unknown` until a dated source exists. Health is a stored
 * observation, never a live probe.
 */
export type ProviderCategory = "search" | "model" | "embedding" | "extraction" | "storage";

export interface ProviderPricing {
  currency: string;
  /** Price per 1M input tokens, in the smallest unit described by `currency`. */
  inputPer1M?: number;
  outputPer1M?: number;
  /** Dated source of the price (plan/source log). */
  source: string;
  verifiedAt: string;
}

export interface ProviderTerms {
  source: string;
  verifiedAt: string;
}

export interface ProviderHealth {
  status: "ok" | "degraded" | "failed";
  observedAt: string;
  /** Reference to a stored receipt, not a live call. */
  receipt?: string;
}

export interface ProviderRecord {
  id: string;
  category: ProviderCategory;
  /** Credentials/configuration present. */
  configured: boolean;
  /** Capability grant / owner opt-in recorded. */
  permitted: boolean;
  /** Why a configured provider is disabled; a reason is required when not permitted. */
  disabledReason?:
    | "missing-opt-in"
    | "stale-terms"
    | "unverified-price"
    | "missing-credentials"
    | "health-failure";
  terms?: ProviderTerms;
  pricing?: ProviderPricing;
  health?: ProviderHealth;
}

export interface ProviderStatus {
  id: string;
  category: ProviderCategory;
  configured: boolean;
  /** Configured AND permitted; never inferred from price availability. */
  available: boolean;
  permitted: boolean;
  healthy: "ok" | "degraded" | "failed" | "unknown";
  pricing:
    | "unknown"
    | {
        currency: string;
        inputPer1M?: number;
        outputPer1M?: number;
        source: string;
        verifiedAt: string;
      };
  disabledReason?: ProviderRecord["disabledReason"];
}

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

export function providerStatus(record: ProviderRecord): ProviderStatus {
  if (record.id.trim() === "") throw new ProviderRegistryError("provider id must not be empty");
  if (!record.permitted && record.disabledReason === undefined) {
    throw new ProviderRegistryError(
      `provider "${record.id}" is not permitted but names no disabledReason`,
    );
  }
  if (record.pricing !== undefined && record.pricing.verifiedAt.trim() === "") {
    throw new ProviderRegistryError(`provider "${record.id}" has pricing without a verified date`);
  }
  const status: ProviderStatus = {
    id: record.id,
    category: record.category,
    configured: record.configured,
    available: record.configured && record.permitted,
    permitted: record.permitted,
    healthy: record.health?.status ?? "unknown",
    pricing:
      record.pricing === undefined
        ? "unknown"
        : {
            currency: record.pricing.currency,
            ...(record.pricing.inputPer1M === undefined
              ? {}
              : { inputPer1M: record.pricing.inputPer1M }),
            ...(record.pricing.outputPer1M === undefined
              ? {}
              : { outputPer1M: record.pricing.outputPer1M }),
            source: record.pricing.source,
            verifiedAt: record.pricing.verifiedAt,
          },
  };
  if (record.disabledReason !== undefined) status.disabledReason = record.disabledReason;
  return status;
}

/** Sorted, deduplicated by id. Duplicate ids are an error, not a silent overwrite. */
export function buildProviderRegistry(records: readonly ProviderRecord[]): ProviderStatus[] {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new ProviderRegistryError(`duplicate provider id "${record.id}"`);
    }
    seen.add(record.id);
  }
  return records
    .map(providerStatus)
    .sort((a, b) =>
      a.category === b.category ? (a.id < b.id ? -1 : 1) : a.category < b.category ? -1 : 1,
    );
}

/** One-line operator label; unknown never becomes "free". */
export function describeProvider(status: ProviderStatus): string {
  const availability = status.available
    ? "available"
    : status.configured
      ? "disabled"
      : "unconfigured";
  const price =
    status.pricing === "unknown"
      ? "price unknown"
      : `${status.pricing.currency} ${status.pricing.inputPer1M ?? "?"}/${status.pricing.outputPer1M ?? "?"} per 1M tokens (${status.pricing.verifiedAt})`;
  const reason = status.disabledReason === undefined ? "" : `, reason: ${status.disabledReason}`;
  return `${status.id} [${status.category}] ${availability}${reason}, health ${status.healthy}, ${price}`;
}
