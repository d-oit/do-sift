/** Shared request/envelope builders for the openai-compat model plugin tests. */
import { SynthesisRequest } from "@do-sift/contracts";
import {
  createOpenAICompatModel,
  type OpenAICompatModelDeps,
  type OpenAICompatModelInstance,
} from "../src/index.js";
export const BASE = "https://api.example.test/openai/v1";
export function request(overrides: Record<string, unknown> = {}): SynthesisRequest {
  return SynthesisRequest.parse({
    question: "What matters for bm25 ranking quality?",
    passages: [
      { id: "ev-1", text: "bm25 weighting rewards term frequency saturation control." },
      { id: "ev-2", text: "Field length normalization keeps long documents from dominating." },
    ],
    followUps: [],
    maxInputTokens: 4000,
    maxOutputTokens: 700,
    ...overrides,
  });
}
export const GOOD_CONTENT = JSON.stringify({
  blocks: [
    {
      kind: "paragraph",
      text: "bm25 weighting rewards term frequency saturation control.",
      citations: ["ev-1"],
    },
    {
      kind: "paragraph",
      text: "Field length normalization keeps long documents from dominating.",
      citations: ["ev-2"],
    },
  ],
});
export function completionEnvelope(content: string, usage?: unknown): Response {
  const body: Record<string, unknown> = {
    id: "chatcmpl-fixture-1",
    object: "chat.completion",
    created: 1758450000,
    model: "probe-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
  if (usage !== undefined) body.usage = usage;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
export const PROVIDER_USAGE = { prompt_tokens: 412, completion_tokens: 96, total_tokens: 508 };
export type FetchLog = { url: string; init?: RequestInit | undefined }[];
export function ctx(config: unknown) {
  return {
    pluginName: "model-openai-compat",
    config,
    events: { emit: () => {} },
    network: { assertHostAllowed: () => {} },
    secrets: { assertNameAllowed: () => {}, resolve: async () => "" },
    logger: { info: () => {}, warn: () => {} },
  } as unknown as Parameters<OpenAICompatModelInstance["activate"]>[0];
}
export function depsWith(
  fetchLog: FetchLog,
  responses: Response[],
  extra: OpenAICompatModelDeps = {},
): OpenAICompatModelDeps {
  let call = 0;
  return {
    fetchImpl: async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const res = responses[Math.min(call, responses.length - 1)]!;
      call++;
      return res;
    },
    ...extra,
  };
}
export async function activated(
  config: unknown,
  deps: OpenAICompatModelDeps = {},
): Promise<OpenAICompatModelInstance> {
  const plugin = createOpenAICompatModel(deps);
  await plugin.activate(ctx(config));
  return plugin;
}
export function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseURL: BASE,
    modelId: "probe-model",
    termsAcceptedAt: "2026-09-21",
    sourcesEntry: "Model providers — candidate (NOT activated), checked 2026-09-21",
    ...overrides,
  };
}
