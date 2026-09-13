/**
 * Offline fake providers (CORE-09). Implement the contract interfaces from
 * @do-sift/contracts with deterministic, fixture-backed behavior: no
 * network, no timers, no randomness. Used by tests and evals until real
 * providers pass their terms/quota gates (plans/sources.md).
 */
import {
  SearchHit,
  SearchLimits,
  SearchQuery,
  SynthesisRequest,
  estimateTokens,
  type DraftAnswer,
  type ModelProvider,
  type SearchProvider,
} from "@do-sift/contracts";

/** Thrown when a fake provider's caller aborts before the call. */
export class AbortedError extends Error {
  constructor(message = "aborted before the fake provider ran") {
    super(message);
    this.name = "AbortedError";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

export interface FakeSearchHitInput {
  url: string;
  title?: string | undefined;
  snippet?: string | undefined;
  rank?: number | undefined;
  provider?: string | undefined;
}

/** Build one contract-valid SearchHit with deterministic defaults. */
export function makeFakeSearchHit(input: FakeSearchHitInput, index = 0): SearchHit {
  return SearchHit.parse({
    url: input.url,
    title: input.title ?? `Fixture result ${index + 1}`,
    snippet: input.snippet ?? `Snippet ${index + 1} from ${input.url}`,
    provider: input.provider ?? "fake-search",
    rank: input.rank ?? index,
  });
}

export interface FakeSearchProviderOptions {
  name?: string;
  hits: Array<FakeSearchHitInput | SearchHit>;
}

/**
 * Serves a fixed hit list, newest fixture order first, truncated to
 * limits.maxHits. Records every query for assertions. Deterministic: no
 * delays, no jitter; `limits.timeoutMs` is deliberately not simulated.
 */
export class FakeSearchProvider implements SearchProvider {
  readonly name: string;
  readonly queries: SearchQuery[] = [];
  private readonly hits: SearchHit[];

  constructor(options: FakeSearchProviderOptions) {
    this.name = options.name ?? "fake-search";
    // makeFakeSearchHit keeps provided fields and fills contract-valid
    // defaults, then SearchHit.parse validates the result.
    this.hits = options.hits.map((h, i) => makeFakeSearchHit(h, i));
  }

  async search(
    query: SearchQuery,
    limits: SearchLimits,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    assertNotAborted(signal);
    SearchQuery.parse(query);
    SearchLimits.parse(limits);
    this.queries.push(query);
    return this.hits.slice(0, limits.maxHits);
  }
}

export type FakeModelCitationBehavior = "grounded" | "hallucinate";

export interface FakeModelProviderOptions {
  name?: string;
  modelId?: string;
  /**
   * grounded (default): every citation resolves to a passage id in the
   * request — the pass path for ANS-03. hallucinate: citations reference
   * ids that were never provided — feeds the invalid-citation →
   * evidence-only degradation tests.
   */
  citationBehavior?: FakeModelCitationBehavior;
  /** When set, complete() rejects with this error (provider-failure path). */
  failWith?: Error;
  /**
   * Overrides reported usage as a provider-reported count (estimated:
   * false) instead of the estimator's guess — feeds ANS-04's usage
   * reconciliation tests, including overruns.
   */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface FakeModelCall {
  question: string;
  passageIds: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * Deterministic single-call model adapter (ADR 0006: no tool loops, no
 * retries). One paragraph block per passage, citing exactly that passage's
 * id. Token usage is the contract's conservative estimator.
 */
export class FakeModelProvider implements ModelProvider {
  readonly name: string;
  readonly modelId: string;
  readonly calls: FakeModelCall[] = [];
  private readonly citationBehavior: FakeModelCitationBehavior;
  private readonly failWith: Error | undefined;

  constructor(options: FakeModelProviderOptions = {}) {
    this.name = options.name ?? "fake-model";
    this.modelId = options.modelId ?? "fake-model-1";
    this.citationBehavior = options.citationBehavior ?? "grounded";
    this.failWith = options.failWith;
    this.usageOverride = options.usage;
  }

  private readonly usageOverride: { inputTokens: number; outputTokens: number } | undefined;

  async complete(request: SynthesisRequest, signal?: AbortSignal): Promise<DraftAnswer> {
    assertNotAborted(signal);
    if (this.failWith) throw this.failWith;
    SynthesisRequest.parse(request);

    this.calls.push({
      question: request.question,
      passageIds: request.passages.map((p) => p.id),
      maxInputTokens: request.maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
    });

    const blocks =
      this.citationBehavior === "hallucinate"
        ? request.passages.map((p) => ({
            kind: "paragraph" as const,
            text: `Claim citing absent evidence for ${p.id}.`,
            citations: [`ev-hallucinated-${p.id}`],
          }))
        : request.passages.map((p) => ({
            kind: "paragraph" as const,
            text: `According to evidence ${p.id}: ${p.text}`,
            citations: [p.id],
          }));

    const text = blocks.map((b) => b.text).join(" ");
    return {
      blocks,
      usage: this.usageOverride
        ? { ...this.usageOverride, model: this.modelId, estimated: false }
        : {
            inputTokens: estimateTokens(
              [request.question, ...request.passages.map((p) => p.text), ...request.followUps].join(
                " ",
              ),
            ),
            outputTokens: estimateTokens(text),
            model: this.modelId,
            estimated: true,
          },
    };
  }
}
