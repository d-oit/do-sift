/**
 * fastembed-backed TextEmbedder (RET-02, ADR 0009): local ONNX inference via
 * onnxruntime-node — no Python, no hosted API, zero network after the
 * one-time model download (cached in the gitignored .fastembed_cache/).
 * Passages embed raw; queries get the bge v1.5 documented search prefix.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import type { TextEmbedder } from "./embeddings.js";

export const EMBEDDING_MODEL_ID = "bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const HF_MODEL_FILES = [
  "model_optimized.onnx",
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
];
const HF_BASE_URL = "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/main";

export interface FastEmbedEmbedderOptions {
  /** Model cache directory; defaults to <cwd>/.fastembed_cache (gitignored). */
  cacheDir?: string | undefined;
}

/**
 * Ensure model files exist locally in cacheDir/fast-bge-small-en-v1.5.
 * Downloads directly from HuggingFace if missing to avoid fastembed's
 * broken GCS tarball URL.
 */
async function ensureModelFiles(cacheDir: string): Promise<string> {
  const modelDir = join(cacheDir, "fast-bge-small-en-v1.5");
  if (!existsSync(modelDir)) {
    mkdirSync(modelDir, { recursive: true });
  }
  for (const file of HF_MODEL_FILES) {
    const filePath = join(modelDir, file);
    if (!existsSync(filePath)) {
      const response = await fetch(`${HF_BASE_URL}/${file}`, {
        headers: { "user-agent": "Mozilla/5.0" },
      });
      if (!response.ok) {
        throw new Error(
          `Failed to download ${file} for fastembed: ${response.status} ${response.statusText}`,
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
    }
  }
  return modelDir;
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
  await ensureModelFiles(cacheDir);
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
