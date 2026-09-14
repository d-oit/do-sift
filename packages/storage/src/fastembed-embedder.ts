/**
 * fastembed-backed TextEmbedder (RET-02, ADR 0009): local ONNX inference via
 * onnxruntime-node — no Python, no hosted API, zero network after the
 * one-time model download (cached in the gitignored .fastembed_cache/).
 * Passages embed raw; queries get the bge v1.5 documented search prefix.
 */
import { join } from "node:path";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import type { TextEmbedder } from "./embeddings.js";

export const EMBEDDING_MODEL_ID = "bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export interface FastEmbedEmbedderOptions {
  /** Model cache directory; defaults to <cwd>/.fastembed_cache (gitignored). */
  cacheDir?: string | undefined;
}

/** Flatten the async batch generator into one array of vectors. */
async function embedAll(embedder: FlagEmbedding, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for await (const batch of embedder.embed(texts)) {
    out.push(...batch);
  }
  return out;
}

export async function createFastEmbedEmbedder(
  options: FastEmbedEmbedderOptions = {},
): Promise<TextEmbedder> {
  const cacheDir = options.cacheDir ?? join(process.cwd(), ".fastembed_cache");
  const embedder = await FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15,
    cacheDir,
    showDownloadProgress: false,
  });
  return {
    modelId: EMBEDDING_MODEL_ID,
    async embedPassages(texts: string[]): Promise<number[][]> {
      return embedAll(embedder, texts);
    },
    async embedQuery(text: string): Promise<number[]> {
      const vectors = await embedAll(embedder, [QUERY_PREFIX + text]);
      const first = vectors[0];
      if (first === undefined) throw new Error("fastembed returned no vector for the query");
      return first;
    },
  };
}
