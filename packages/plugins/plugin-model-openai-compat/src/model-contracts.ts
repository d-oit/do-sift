/** Config, failure kinds, and the provider error type for the openai-compat model plugin. */
export interface OpenAICompatModelConfig {
  baseURL?: unknown;
  modelId?: unknown;
  responseFormat?: unknown;
  schemaName?: unknown;
  maxOutputTokens?: unknown;
  termsAcceptedAt?: unknown;
  sourcesEntry?: unknown;
}
export type ResponseFormatMode = "strict" | "best-effort" | "json";
export type ModelFailureKind = "http" | "rate-limited" | "timeout" | "aborted";
export class ModelProviderError extends Error {
  constructor(
    public readonly kind: ModelFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface OpenAICompatModelDeps {
  /** Injectable for offline tests; defaults to the platform fetch. */
  fetchImpl?: FetchLike | undefined;
  /**
   * Provider key from the host secret service (Groq/Gemini-class hosts).
   * Undefined for keyless local servers (Ollama loopback). Never config.
   */
  apiKey?: string | undefined;
  /** Per-call ceiling; the caller's signal composes with it. */
  timeoutMs?: number | undefined;
}
