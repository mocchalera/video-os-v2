#!/usr/bin/env tsx
import * as path from "node:path";
import {
  buildFootageDb,
  type FootageDbEmbeddingPolicy,
  type FootageDbRebuildMode,
  type Qwen3VlBuildEmbeddingType,
} from "../runtime/artifacts/footage-db-builder.js";
import {
  PipelineStageProgressTracker,
  formatStageFailureMessage,
  readSegmentCount,
} from "../runtime/progress.js";

interface Args {
  project?: string;
  output?: string;
  embeddingPolicy?: FootageDbEmbeddingPolicy;
  rebuildMode?: FootageDbRebuildMode;
  allowRemoteEmbeddingModels?: boolean;
  skipAudioAnalysis?: boolean;
  qwen3vlEnabled?: boolean;
  qwen3vlEmbedTypes?: Qwen3VlBuildEmbeddingType[];
  clapAudioEnabled?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--project") {
      args.project = value;
      index += 1;
    } else if (arg === "--output") {
      args.output = value;
      index += 1;
    } else if (arg === "--embedding-policy") {
      if (!isEmbeddingPolicy(value)) throw new Error("--embedding-policy must be skip, auto, or require");
      args.embeddingPolicy = value;
      index += 1;
    } else if (arg === "--rebuild-mode") {
      if (!isRebuildMode(value)) throw new Error("--rebuild-mode must be full or incremental");
      args.rebuildMode = value;
      index += 1;
    } else if (arg === "--allow-remote-embedding-models") {
      args.allowRemoteEmbeddingModels = true;
    } else if (arg === "--skip-audio-analysis") {
      args.skipAudioAnalysis = true;
    } else if (arg === "--qwen3vl") {
      args.qwen3vlEnabled = true;
    } else if (arg === "--no-qwen3vl") {
      args.qwen3vlEnabled = false;
    } else if (arg === "--qwen3vl-embed-types") {
      args.qwen3vlEmbedTypes = parseQwen3VlEmbedTypes(value);
      index += 1;
    } else if (arg === "--clap-audio") {
      args.clapAudioEnabled = true;
    } else if (arg === "--no-clap-audio") {
      args.clapAudioEnabled = false;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) usage(1);
  const projectDir = path.resolve(args.project);
  const stageProgress = new PipelineStageProgressTracker({
    projectDir,
    entrypoint: "build-footage-db",
    stages: ["embeddings"],
    segmentCount: readSegmentCount(projectDir),
  });
  let result: Awaited<ReturnType<typeof buildFootageDb>> | undefined;
  try {
    result = await stageProgress.track("embeddings", () => buildFootageDb({
      projectDir,
      outputPath: args.output ? path.resolve(args.output) : undefined,
      embeddingPolicy: args.embeddingPolicy ?? "auto",
      rebuildMode: args.rebuildMode ?? "full",
      allowRemoteEmbeddingModels: args.allowRemoteEmbeddingModels ?? false,
      skipAudioAnalysis: args.skipAudioAnalysis ?? false,
      qwen3vlEnabled: args.qwen3vlEnabled,
      qwen3vlEmbedTypes: args.qwen3vlEmbedTypes,
      clapAudioEnabled: args.clapAudioEnabled,
      onQwen3VlProgress: (progress) => {
        process.stderr.write(`[footage-db] qwen ${progress.phase}: ${progress.completed}/${progress.total}\n`);
      },
      onClapAudioProgress: (progress) => {
        process.stderr.write(`[footage-db] clap ${progress.phase}: ${progress.completed}/${progress.total}\n`);
      },
    }));
    stageProgress.finish("completed");
  } catch (error) {
    stageProgress.finish("failed");
    throw new Error(formatStageFailureMessage("build-footage-db", projectDir, "embeddings", error));
  }
  if (!result) return;
  if (result.embedding_counts && result.embedding_statuses) {
    process.stderr.write(
      `[footage-db] qwen visual=${result.embedding_statuses.qwen_visual}(${result.embedding_counts.qwen_visual}) ` +
      `text=${result.embedding_statuses.qwen_text}(${result.embedding_counts.qwen_text}) ` +
      `mixed=${result.embedding_statuses.qwen_mixed} reranker=${result.embedding_statuses.qwen_reranker} ` +
      `clap_audio=${result.embedding_statuses.clap_audio}(${result.embedding_counts.clap_audio})\n`
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isEmbeddingPolicy(value: string | undefined): value is FootageDbEmbeddingPolicy {
  return value === "skip" || value === "auto" || value === "require";
}

function isRebuildMode(value: string | undefined): value is FootageDbRebuildMode {
  return value === "full" || value === "incremental";
}

function parseQwen3VlEmbedTypes(value: string | undefined): Qwen3VlBuildEmbeddingType[] {
  if (!value) throw new Error("--qwen3vl-embed-types must be visual,text or explicit embedding type names");
  const result: Qwen3VlBuildEmbeddingType[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    if (item === "visual" || item === "visual_representative") {
      result.push("visual_representative");
    } else if (item === "text" || item === "text_combined_qwen") {
      result.push("text_combined_qwen");
    } else {
      throw new Error("--qwen3vl-embed-types must contain only visual,text,visual_representative,text_combined_qwen");
    }
  }
  if (result.length === 0) throw new Error("--qwen3vl-embed-types must include at least one type");
  return Array.from(new Set(result));
}

function usage(exitCode: number): never {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: npx tsx scripts/build-footage-db.ts --project <path> [options]

Options:
  --output <path>                  default: <project>/03_analysis/search/footage.db
  --embedding-policy auto|skip|require  default: auto
  --rebuild-mode full|incremental
  --skip-audio-analysis          leave audio level/silence fields null
  --allow-remote-embedding-models  default false
  --qwen3vl                      enable Qwen3-VL embeddings (default)
  --no-qwen3vl                   disable Qwen3-VL embeddings
  --qwen3vl-embed-types visual,text
  --clap-audio                   enable CLAP audio embeddings
  --no-clap-audio                disable CLAP audio embeddings
`);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
