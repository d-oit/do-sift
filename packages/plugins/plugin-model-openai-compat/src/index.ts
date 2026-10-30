/** openai-compat model plugin. Contracts, request-body assembly, and baseURL parsing live in sibling modules. */
import {
  USER_AGENT as CONTRACT_USER_AGENT,
  DraftAnswer,
  SynthesisRequest,
  estimateTokens,
  type DraftAnswer as DraftAnswerT,
  type SynthesisRequest as SynthesisRequestT,
} from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";
import { ModelProviderError } from "./model-contracts.js";
import type {
  FetchLike,
  OpenAICompatModelConfig,
  OpenAICompatModelDeps,
  ResponseFormatMode,
} from "./model-contracts.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_CEILING,
  buildChatBody,
  nonNegativeInt,
} from "./chat-body.js";
import { parseBaseURL } from "./base-url.js";
export type { OpenAICompatModelConfig } from "./model-contracts.js";
export type { ResponseFormatMode } from "./model-contracts.js";
export type { ModelFailureKind } from "./model-contracts.js";
export type { FetchLike } from "./model-contracts.js";
export type { OpenAICompatModelDeps } from "./model-contracts.js";
export { ModelProviderError } from "./model-contracts.js";
export { DRAFT_BLOCKS_JSON_SCHEMA } from "./chat-body.js";
export { DEFAULT_MAX_OUTPUT_TOKENS } from "./chat-body.js";
export { MAX_OUTPUT_TOKENS_CEILING } from "./chat-body.js";
export { buildChatBody } from "./chat-body.js";
export const USER_AGENT = CONTRACT_USER_AGENT;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u;

export interface OpenAICompatModelInstance extends PluginInstance {
  /** Contract identity (ModelProvider.name) — provenance records it. */
  readonly name: string;
  complete(request: SynthesisRequestT, signal?: AbortSignal): Promise<DraftAnswerT>;
  readonly modelId: string;
}

export function createOpenAICompatModel(
  deps: OpenAICompatModelDeps = {},
): OpenAICompatModelInstance {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const apiKey = deps.apiKey;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  let baseURL = "";
  let modelId = "";
  let mode: ResponseFormatMode = "strict";
  let schemaName = "grounded_answer";
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  let activated = false;

  return {
    name: "openai-compat",
    get modelId() {
      return modelId;
    },

    async activate(context) {
      const cfg = context.config as OpenAICompatModelConfig;
      // Terms gate (SRC-02 pattern, same as the search adapters): no dated
      // sources.md entry, no activation — even for free/keyless local
      // servers, whose runner/model licenses are the recorded terms.
      const acceptedAt = cfg.termsAcceptedAt;
      const entry = cfg.sourcesEntry;
      if (typeof acceptedAt !== "string" || !ISO_DATE.test(acceptedAt)) {
        throw new ModelProviderError(
          "http",
          "activation refused: config.termsAcceptedAt must record the date the provider terms were checked (see plans/sources.md)",
        );
      }
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new ModelProviderError(
          "http",
          "activation refused: config.sourcesEntry must name the plans/sources.md entry that clears this provider",
        );
      }
      baseURL = parseBaseURL(cfg.baseURL);
      // #57: the provider host is network I/O and must be declared in the manifest's networkHosts.
      context.network.assertHostAllowed(new URL(baseURL).hostname);
      if (typeof cfg.modelId !== "string" || cfg.modelId.trim().length === 0) {
        throw new ModelProviderError(
          "http",
          "activation refused: config.modelId must be a non-empty provider model id",
        );
      }
      modelId = cfg.modelId.trim();
      if (cfg.responseFormat !== undefined) {
        if (
          cfg.responseFormat !== "strict" &&
          cfg.responseFormat !== "best-effort" &&
          cfg.responseFormat !== "json"
        ) {
          throw new ModelProviderError(
            "http",
            'activation refused: config.responseFormat must be "strict", "best-effort", or "json" when provided',
          );
        }
        mode = cfg.responseFormat;
      }
      if (cfg.schemaName !== undefined) {
        if (typeof cfg.schemaName !== "string" || cfg.schemaName.trim().length === 0) {
          throw new ModelProviderError(
            "http",
            "activation refused: config.schemaName must be a non-empty string when provided",
          );
        }
        schemaName = cfg.schemaName.trim();
      }
      if (cfg.maxOutputTokens !== undefined) {
        if (
          typeof cfg.maxOutputTokens !== "number" ||
          !Number.isInteger(cfg.maxOutputTokens) ||
          cfg.maxOutputTokens < 1 ||
          cfg.maxOutputTokens > MAX_OUTPUT_TOKENS_CEILING
        ) {
          throw new ModelProviderError(
            "http",
            `activation refused: config.maxOutputTokens must be an integer 1..${MAX_OUTPUT_TOKENS_CEILING} when provided`,
          );
        }
        maxOutputTokens = cfg.maxOutputTokens;
      }
      activated = true;
      context.events.emit("model-openai-compat.activated", { modelId, baseURL, mode });
    },

    async deactivate() {
      activated = false;
    },

    async complete(request, signal?): Promise<DraftAnswerT> {
      if (!activated) {
        throw new ModelProviderError("http", "model-openai-compat is not activated");
      }
      const req = SynthesisRequest.parse(request);
      const url = `${baseURL}/chat/completions`;
      const effectiveSignal =
        signal === undefined
          ? AbortSignal.timeout(timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        accept: "application/json",
      };
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(
            buildChatBody(req, { model: modelId, schemaName, mode, maxOutputTokens }),
          ),
          signal: effectiveSignal,
        });
      } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") {
          throw new ModelProviderError(
            "timeout",
            `model completion timed out after ${timeoutMs}ms`,
          );
        }
        if (e instanceof Error && e.name === "AbortError") {
          throw new ModelProviderError("aborted", "model completion aborted");
        }
        throw new ModelProviderError(
          "http",
          `model completion transport failure: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (res.status === 429) {
        // Single-call discipline (ADR 0006): a synthesis call may be
        // billable, so 429 is reported, never retried here.
        throw new ModelProviderError(
          "rate-limited",
          "model completion is rate-limited (429 — no retry on a possibly-billable call)",
        );
      }
      if (!res.ok) {
        throw new ModelProviderError("http", `model completion failed: HTTP ${res.status}`);
      }
      let envelope: unknown;
      try {
        envelope = await res.json();
      } catch {
        throw new ModelProviderError(
          "http",
          "model completion returned a non-JSON body with HTTP 200",
        );
      }
      const content =
        typeof envelope === "object" &&
        envelope !== null &&
        Array.isArray((envelope as { choices?: unknown }).choices) &&
        typeof (envelope as { choices: Array<{ message?: unknown }> }).choices[0]?.message ===
          "object" &&
        (envelope as { choices: Array<{ message: { content?: unknown } }> }).choices[0]?.message !==
          null
          ? (envelope as { choices: Array<{ message: { content?: unknown } }> }).choices[0]?.message
              .content
          : undefined;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new ModelProviderError(
          "http",
          "model completion envelope carries no text content (refusal or empty completion)",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ModelProviderError("http", "model completion content is not JSON");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as { blocks?: unknown }).blocks)
      ) {
        throw new ModelProviderError("http", "model completion JSON has no blocks array");
      }
      const promptTokens = nonNegativeInt(
        (envelope as { usage?: { prompt_tokens?: unknown } }).usage?.prompt_tokens,
      );
      const completionTokens = nonNegativeInt(
        (envelope as { usage?: { completion_tokens?: unknown } }).usage?.completion_tokens,
      );
      const usage =
        promptTokens === undefined || completionTokens === undefined
          ? {
              inputTokens: estimateTokens(
                [req.question, ...req.passages.map((p) => p.text), ...req.followUps].join(" "),
              ),
              outputTokens: estimateTokens(content),
              model: modelId,
              estimated: true,
            }
          : {
              inputTokens: promptTokens,
              outputTokens: completionTokens,
              model: modelId,
              estimated: false,
            };
      // The contract is the verdict on shape: citations that name unknown
      // ids fail here or downstream at the ANS-03 citation gate — either
      // way they never reach the user as grounded claims.
      try {
        return DraftAnswer.parse({
          blocks: (parsed as { blocks: unknown }).blocks,
          usage,
        });
      } catch {
        throw new ModelProviderError(
          "http",
          "model completion blocks do not match the DraftAnswer contract",
        );
      }
    },
  };
}
