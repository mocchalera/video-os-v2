import * as os from "node:os";
import * as path from "node:path";

type EmbeddingPipeline = import("@huggingface/transformers").AllTasks["feature-extraction"];
type TensorLike = {
  data: Float32Array | Float64Array | number[];
  dims: number[];
};

export interface SemanticMatchResult {
  item: string;
  bestMatch: { text: string; score: number } | null;
  matched: boolean;
}

export const SEMANTIC_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const SEMANTIC_EMBEDDING_DTYPE = "q8";
export const DEFAULT_SEMANTIC_MATCH_THRESHOLD = 0.82;

let embeddingPipeline: EmbeddingPipeline | null = null;
let embeddingPipelinePromise: Promise<EmbeddingPipeline | null> | null = null;
let warnedUnavailable = false;

export function resolveEmbeddingCacheDir(): string {
  return (
    process.env.VIDEO_OS_EMBEDDING_CACHE_DIR ??
    path.join(os.homedir(), ".cache", "video-os-v2", "transformers")
  );
}

function warnEmbeddingUnavailable(error: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[semantic-match] local embedding model unavailable; semantic must_have matching skipped (${message})`,
  );
}

function shouldAllowRemoteModels(): boolean {
  return process.env.VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS === "1";
}

async function loadEmbeddingPipeline(): Promise<EmbeddingPipeline | null> {
  try {
    const transformers = await import("@huggingface/transformers");
    const cacheDir = resolveEmbeddingCacheDir();
    const allowRemoteModels = shouldAllowRemoteModels();

    transformers.env.cacheDir = cacheDir;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = allowRemoteModels;

    const pipeline = await transformers.pipeline(
      "feature-extraction",
      SEMANTIC_EMBEDDING_MODEL,
      {
        dtype: SEMANTIC_EMBEDDING_DTYPE,
        cache_dir: cacheDir,
        local_files_only: !allowRemoteModels,
      },
    );

    transformers.env.allowRemoteModels = false;
    embeddingPipeline = pipeline;
    return pipeline;
  } catch (error) {
    warnEmbeddingUnavailable(error);
    return null;
  }
}

async function getEmbeddingPipeline(): Promise<EmbeddingPipeline | null> {
  if (embeddingPipeline) return embeddingPipeline;
  embeddingPipelinePromise ??= loadEmbeddingPipeline();
  return embeddingPipelinePromise;
}

// Initialize the embedding pipeline (lazy singleton, cached after first call).
export async function initEmbeddingPipeline(): Promise<void> {
  await getEmbeddingPipeline();
}

function prefixedText(text: string, prefix: "query" | "passage"): string {
  return `${prefix}: ${text}`;
}

function normalizeVector(values: ArrayLike<number>): Float32Array {
  let magnitude = 0;
  for (let i = 0; i < values.length; i += 1) {
    magnitude += values[i] * values[i];
  }
  const normalized = new Float32Array(values.length);
  if (magnitude <= 0) return normalized;
  const scale = 1 / Math.sqrt(magnitude);
  for (let i = 0; i < values.length; i += 1) {
    normalized[i] = values[i] * scale;
  }
  return normalized;
}

function tensorRows(tensor: TensorLike): Float32Array[] {
  const [rows, cols] = tensor.dims;
  if (tensor.dims.length !== 2 || rows === undefined || cols === undefined) {
    throw new Error(`unexpected embedding tensor shape: [${tensor.dims.join(", ")}]`);
  }
  const vectors: Float32Array[] = [];
  for (let row = 0; row < rows; row += 1) {
    const start = row * cols;
    const end = start + cols;
    vectors.push(normalizeVector(tensor.data.slice(start, end)));
  }
  return vectors;
}

// Embed a batch of strings, return normalized vectors.
export async function embedTexts(
  texts: string[],
  prefix: "query" | "passage" = "passage",
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipeline = await getEmbeddingPipeline();
  if (!pipeline) return [];

  const output = await pipeline(
    texts.map((text) => prefixedText(text, prefix)),
    { pooling: "mean", normalize: true },
  );
  const vectors = tensorRows(output as TensorLike);
  if (vectors.length !== texts.length) {
    throw new Error(`embedding row count mismatch: expected ${texts.length}, got ${vectors.length}`);
  }
  return vectors;
}

// Compute cosine similarity between two normalized vectors.
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

function unmatchedResults(mustHaveItems: string[]): SemanticMatchResult[] {
  return mustHaveItems.map((item) => ({ item, bestMatch: null, matched: false }));
}

// Match must_have items against candidate evidence using semantic similarity.
export async function semanticMustHaveMatch(
  mustHaveItems: string[],
  candidateTexts: string[],
  threshold = DEFAULT_SEMANTIC_MATCH_THRESHOLD,
): Promise<SemanticMatchResult[]> {
  const items = mustHaveItems.map((item) => item.trim()).filter((item) => item.length > 0);
  const texts = candidateTexts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (items.length === 0) return [];
  if (texts.length === 0) return unmatchedResults(items);

  try {
    const queryVectors = await embedTexts(items, "query");
    const passageVectors = await embedTexts(texts, "passage");
    if (queryVectors.length !== items.length || passageVectors.length !== texts.length) {
      return unmatchedResults(items);
    }

    return items.map((item, itemIndex): SemanticMatchResult => {
      let bestMatch: SemanticMatchResult["bestMatch"] = null;
      for (let textIndex = 0; textIndex < texts.length; textIndex += 1) {
        const score = cosineSimilarity(queryVectors[itemIndex], passageVectors[textIndex]);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { text: texts[textIndex], score };
        }
      }
      return {
        item,
        bestMatch,
        matched: Boolean(bestMatch && bestMatch.score >= threshold),
      };
    });
  } catch (error) {
    warnEmbeddingUnavailable(error);
    return unmatchedResults(items);
  }
}
