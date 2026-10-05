/**
 * fastembed-backed TextEmbedder (RET-02, ADR 0009): local ONNX inference via
 * onnxruntime-node — no Python, no hosted API, zero network after the
 * one-time model download (cached in the gitignored .fastembed_cache/).
 * Passages embed raw; queries get the bge v1.5 documented search prefix.
 *
 * QF-02: a failed download can leave a poisoned archive in the cache (e.g. a
 * proxy error body saved as the model tar). Init detects that corrupt-archive
 * failure, clears ONLY the downloaded artifacts, and retries once; a still
 * failing init throws one readable error (no tar stack dump).
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import type { TextEmbedder } from "./embeddings.js";

export const EMBEDDING_MODEL_ID = "bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export interface FastEmbedEmbedderOptions {
  /** Model cache directory; defaults to <cwd>/.fastembed_cache (gitignored). */
  cacheDir?: string | undefined;
}

/** First line of an error for readable operational messages (no stack dump). */
function errorLine(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.split("\n")[0] ?? msg;
}

/** tar's corrupt-archive failure — the signature of a poisoned cache artifact. */
function isCorruptArchiveError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "TAR_BAD_ARCHIVE"
  );
}

/**
 * Remove downloaded model archives (`*.tar.gz`) from the cache, leaving
 * extracted model dirs and unrelated files untouched. Returns the removed
 * paths. Recovery from a poisoned cache (QF-02): the bad download is deleted
 * so init can re-fetch it; a healthy extracted model is never removed.
 */
export function clearModelDownloadArtifacts(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(cacheDir)) {
    if (!entry.endsWith(".tar.gz")) continue;
    const path = join(cacheDir, entry);
    unlinkSync(path);
    removed.push(path);
  }
  return removed;
}

async function initFlagEmbedding(cacheDir: string): Promise<FlagEmbedding> {
  return FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15,
    cacheDir,
    showDownloadProgress: false,
  });
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
  let embedder: FlagEmbedding;
  try {
    embedder = await initFlagEmbedding(cacheDir);
  } catch (err) {
    if (!isCorruptArchiveError(err)) throw err;
    // Poisoned cache: clear only the downloaded artifacts and retry once.
    const removed = clearModelDownloadArtifacts(cacheDir);
    try {
      embedder = await initFlagEmbedding(cacheDir);
    } catch (retryErr) {
      throw new Error(
        `fastembed model unavailable: cleared ${removed.length} corrupt download artifact(s) ` +
          `from ${cacheDir} but re-download/init still failed — ${errorLine(retryErr)}`,
      );
    }
  }
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
