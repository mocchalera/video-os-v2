#!/usr/bin/env tsx

import {
  SEMANTIC_EMBEDDING_DTYPE,
  SEMANTIC_EMBEDDING_MODEL,
  resolveEmbeddingCacheDir,
} from "../runtime/eval/semantic-match.js";

async function main(): Promise<void> {
  const transformers = await import("@huggingface/transformers");
  const cacheDir = resolveEmbeddingCacheDir();

  transformers.env.cacheDir = cacheDir;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = true;

  console.log(`Downloading ${SEMANTIC_EMBEDDING_MODEL} to ${cacheDir}`);
  const extractor = await transformers.pipeline(
    "feature-extraction",
    SEMANTIC_EMBEDDING_MODEL,
    {
      dtype: SEMANTIC_EMBEDDING_DTYPE,
      cache_dir: cacheDir,
      local_files_only: false,
    },
  );

  await extractor(
    ["query: 星空", "passage: starry sky above the campsite"],
    { pooling: "mean", normalize: true },
  );

  transformers.env.allowRemoteModels = false;
  console.log("Embedding model is cached and ready for offline semantic eval.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
