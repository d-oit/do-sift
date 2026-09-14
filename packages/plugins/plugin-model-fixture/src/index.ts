/**
 * Fixture model provider (ANS-02, plan 004). The answer path's first model
 * adapter plugin, deliberately offline (SRC-02 pattern): deterministic
 * extractive synthesis over the evidence already packed into the request —
 * one paragraph block per passage, each citing exactly that passage's id,
 * so the answer service's citation gate passes by construction. Output is
 * trimmed to the request's maxOutputTokens at word boundaries (never
 * empty); usage is the contract's conservative estimator (estimated: true).
 *
 * Single bounded call (ADR 0006): no tool loops, no retries, no fallback,
 * no state between calls. The fixture never invents claims: block text is
 * the stored evidence itself, shaped only by trimming.
 *
 * Zero capabilities: no network, no secrets, no fs — the manifest is the
 * proof. A live paid provider is a separate plugin carrying the `paid`
 * capability, a dated sources.md entry, and verified pricing (INV-003;
 * the ANS-01 router refuses ungated paid selections).
 */
import {
  SynthesisRequest,
  estimateTokens,
  type DraftAnswer,
  type SynthesisRequest as SynthesisRequestT,
} from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface ModelFixtureConfig {
  modelId?: unknown;
}

export class ModelFixtureError extends Error {
  constructor(message: string) {
    super(`model-fixture: ${message}`);
    this.name = "ModelFixtureError";
  }
}

export interface ModelFixtureInstance extends PluginInstance {
  complete(request: SynthesisRequestT, signal?: AbortSignal): Promise<DraftAnswer>;
  readonly modelId: string;
}

/** Largest word-boundary prefix of `text` whose token estimate fits `budget`. */
export function trimToFit(text: string, budgetTokens: number): string {
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0 || budgetTokens < 1) return "";
  let lo = 1;
  let hi = words.length;
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = words.slice(0, mid).join(" ");
    if (estimateTokens(candidate) <= budgetTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function createModelFixture(): ModelFixtureInstance {
  let modelId = "fixture-extractive-1";
  let activated = false;

  return {
    async activate(context) {
      const cfg = context.config as ModelFixtureConfig;
      if (cfg.modelId !== undefined) {
        if (typeof cfg.modelId !== "string" || cfg.modelId.trim().length === 0) {
          throw new ModelFixtureError("config.modelId must be a non-empty string when provided");
        }
        modelId = cfg.modelId;
      }
      activated = true;
      context.events.emit("model-fixture.activated", { modelId });
    },

    async deactivate() {
      activated = false;
    },

    get modelId() {
      return modelId;
    },

    async complete(request, signal?): Promise<DraftAnswer> {
      if (!activated) {
        throw new ModelFixtureError("not activated");
      }
      if (signal?.aborted) {
        throw new ModelFixtureError("aborted before the model call");
      }
      const req = SynthesisRequest.parse(request);

      const blocks: DraftAnswer["blocks"] = [];
      let used = 0;
      for (const passage of req.passages) {
        const remaining = req.maxOutputTokens - used;
        if (remaining < 1) break;
        const fitsWhole = estimateTokens(passage.text) <= remaining;
        const text = fitsWhole ? passage.text : trimToFit(passage.text, remaining);
        if (text.length === 0) break; // budget exhausted below one token
        used += estimateTokens(text);
        blocks.push({ kind: "paragraph", text, citations: [passage.id] });
        if (!fitsWhole) break; // a trimmed block spends the rest of the budget
      }

      return {
        blocks,
        usage: {
          inputTokens: estimateTokens(
            [req.question, ...req.passages.map((p) => p.text), ...req.followUps].join(" "),
          ),
          outputTokens: estimateTokens(blocks.map((b) => b.text).join(" ")),
          model: modelId,
          estimated: true,
        },
      };
    },
  };
}
