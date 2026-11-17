import { describe, expect, it } from "vitest";
import {
  ProviderRegistryError,
  buildProviderRegistry,
  describeProvider,
  providerStatus,
  type ProviderRecord,
} from "@do-sift/contracts";

function record(over: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "wikipedia",
    category: "search",
    configured: true,
    permitted: true,
    ...over,
  };
}

describe("provider registry", () => {
  it("keeps configured, permitted, available, and healthy separate", () => {
    const status = providerStatus(
      record({ health: { status: "degraded", observedAt: "2026-11-17" } }),
    );
    expect(status.configured).toBe(true);
    expect(status.available).toBe(true);
    expect(status.healthy).toBe("degraded");
    expect(status.pricing).toBe("unknown");
  });

  it("never infers free pricing from missing metadata", () => {
    const status = providerStatus(record());
    expect(status.pricing).toBe("unknown");
    expect(describeProvider(status)).toContain("price unknown");
    expect(describeProvider(status)).not.toContain("free");
  });

  it("requires a reason for a disabled provider", () => {
    expect(() => providerStatus(record({ permitted: false }))).toThrow(ProviderRegistryError);
    const status = providerStatus(record({ permitted: false, disabledReason: "missing-opt-in" }));
    expect(status.available).toBe(false);
    expect(describeProvider(status)).toContain("reason: missing-opt-in");
  });

  it("rejects duplicate ids and sorts by category then id", () => {
    expect(() => buildProviderRegistry([record(), record()])).toThrow(ProviderRegistryError);
    const registry = buildProviderRegistry([
      record({ id: "z-search", category: "search" }),
      record({ id: "b-model", category: "model" }),
      record({ id: "a-model", category: "model" }),
    ]);
    expect(registry.map((r) => r.id)).toEqual(["a-model", "b-model", "z-search"]);
  });

  it("carries dated pricing provenance", () => {
    const status = providerStatus(
      record({
        pricing: {
          currency: "USD",
          inputPer1M: 1,
          source: "plans/sources.md (2026-11-01)",
          verifiedAt: "2026-11-01",
        },
      }),
    );
    expect(status.pricing).toEqual({
      currency: "USD",
      inputPer1M: 1,
      source: "plans/sources.md (2026-11-01)",
      verifiedAt: "2026-11-01",
    });
  });
});
