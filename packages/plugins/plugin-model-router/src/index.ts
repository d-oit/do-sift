/**
 * Model router (ANS-01, plan 004). Config-driven choice among injected
 * providers with the two money rules from AGENTS.md / D9:
 *
 * 1. Paid refusal: a provider marked `paid` is selectable only when its
 *    entry records a dated sources.md reference (`termsAcceptedAt` +
 *    `sourcesEntry`). Live paid provider plugins additionally carry the
 *    `paid` capability and face the kernel INV-003 grant gate — this
 *    router's refusal is the selection-time backstop.
 * 2. Cost ceiling: the estimated cost of a call — the request's token
 *    CEILINGS (never optimistic guesses) × verified per-1M-token pricing —
 *    must fit `config.maxCostMicroUsd` when a ceiling is configured. Free
 *    providers (no pricing) cost nothing.
 *
 * Delegation is exactly one bounded call: no retries, no fallback chain,
 * no tool loops (ADR 0006). The router performs no I/O itself; providers
 * are injected host-side.
 */
import type { DraftAnswer, ModelProvider, SynthesisRequest } from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface ProviderPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

export interface RouterProvider {
  name: string;
  provider: ModelProvider;
  /** True when calls to this provider are billable. */
  paid?: boolean | undefined;
  /** Verified pricing; required for the cost ceiling to bound paid calls. */
  pricing?: ProviderPricing | undefined;
  /** The plans/sources.md section clearing this provider (paid only). */
  sourcesEntry?: string | undefined;
  /** ISO date the terms were checked (paid only). */
  termsAcceptedAt?: string | undefined;
}

export interface ModelRouterConfig {
  defaultProvider?: unknown;
  maxCostMicroUsd?: unknown;
}

export type RouterFailureKind =
  "unknown-provider" | "paid-refused" | "cost-ceiling-exceeded" | "not-configured";

export class ModelRouterError extends Error {
  constructor(
    public readonly kind: RouterFailureKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "ModelRouterError";
  }
}

export interface ModelRouterInstance extends PluginInstance {
  complete(request: SynthesisRequest, signal?: AbortSignal): Promise<DraftAnswer>;
  readonly selectedProvider: string | undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Worst-case micro-USD cost from the request ceilings and verified pricing. */
export function estimateCostMicroUsd(request: SynthesisRequest, pricing: ProviderPricing): number {
  const input = (request.maxInputTokens / 1_000_000) * pricing.inputPer1M;
  const output = (request.maxOutputTokens / 1_000_000) * pricing.outputPer1M;
  return Math.ceil((input + output) * 1_000_000);
}

export function createModelRouter(deps: { providers: RouterProvider[] }): ModelRouterInstance {
  let defaultProvider: string | undefined;
  let maxCostMicroUsd: number | undefined;
  let activated = false;
  let selected: string | undefined;

  return {
    async activate(context) {
      const cfg = context.config as ModelRouterConfig;
      const name = cfg.defaultProvider;
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new ModelRouterError(
          "not-configured",
          "config.defaultProvider must name one of the injected providers",
        );
      }
      if (!deps.providers.some((p) => p.name === name)) {
        throw new ModelRouterError(
          "unknown-provider",
          `config.defaultProvider "${name}" is not among the injected providers`,
        );
      }
      defaultProvider = name;
      maxCostMicroUsd = positiveNumber(cfg.maxCostMicroUsd);
      activated = true;
      context.events.emit("model-router.activated", {
        defaultProvider,
        maxCostMicroUsd: maxCostMicroUsd ?? null,
        providers: deps.providers.map((p) => p.name),
      });
    },

    async deactivate() {
      activated = false;
      selected = undefined;
    },

    get selectedProvider() {
      return selected;
    },

    async complete(request: SynthesisRequest, signal?: AbortSignal): Promise<DraftAnswer> {
      if (!activated || defaultProvider === undefined) {
        throw new ModelRouterError("not-configured", "router is not activated");
      }
      if (signal?.aborted) throw new Error("aborted before the model call");

      const entry = deps.providers.find((p) => p.name === defaultProvider);
      if (!entry) {
        throw new ModelRouterError("unknown-provider", `provider "${defaultProvider}" vanished`);
      }

      // ---- paid refusal (D9): no dated sources.md entry, no paid call ----
      if (entry.paid === true) {
        const gateOk =
          typeof entry.sourcesEntry === "string" &&
          entry.sourcesEntry.trim().length > 0 &&
          typeof entry.termsAcceptedAt === "string" &&
          ISO_DATE.test(entry.termsAcceptedAt);
        if (!gateOk || entry.pricing === undefined) {
          throw new ModelRouterError(
            "paid-refused",
            `provider "${entry.name}" is paid: it needs a verified pricing record and a dated plans/sources.md entry (termsAcceptedAt + sourcesEntry) before any billable call`,
          );
        }
      }

      // ---- cost ceiling: ceilings × verified pricing, never guesses ----
      if (maxCostMicroUsd !== undefined && maxCostMicroUsd > 0) {
        // free providers (no pricing) cost nothing; paid providers without
        // pricing were already refused by the gate above
        const cost = entry.pricing === undefined ? 0 : estimateCostMicroUsd(request, entry.pricing);
        if (cost > maxCostMicroUsd) {
          throw new ModelRouterError(
            "cost-ceiling-exceeded",
            `estimated worst case ${cost}µUSD exceeds the configured ceiling ${maxCostMicroUsd}µUSD`,
          );
        }
      }

      selected = entry.name;
      return entry.provider.complete(request, signal);
    },
  };
}
