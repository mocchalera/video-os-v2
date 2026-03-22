#!/usr/bin/env npx tsx
/**
 * CLI entrypoint for the M2 analysis pipeline.
 *
 * Usage:
 *   npx tsx scripts/analyze.ts <source-files...> --project <project-dir>
 *   npx tsx scripts/analyze.ts video1.mp4 video2.mov --project projects/my-project
 *   npx tsx scripts/analyze.ts video.mp4 --project projects/test --skip-stt --skip-vlm
 */

import * as path from "node:path";
import { runPipeline } from "../runtime/pipeline/ingest.js";
import { createGeminiVlmFn } from "../runtime/connectors/gemini-vlm.js";

// ── Arg Parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  sourceFiles: string[];
  projectDir: string;
  skipStt: boolean;
  skipVlm: boolean;
  skipDiarize: boolean;
  language: string | undefined;
  sttProvider: string | undefined;
} {
  const args = argv.slice(2); // skip node + script path
  const sourceFiles: string[] = [];
  let projectDir = "";
  let skipStt = false;
  let skipVlm = false;
  let skipDiarize = false;
  let language: string | undefined;
  let sttProvider: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") {
      projectDir = args[++i] ?? "";
    } else if (arg === "--skip-stt") {
      skipStt = true;
    } else if (arg === "--skip-vlm") {
      skipVlm = true;
    } else if (arg === "--skip-diarize") {
      skipDiarize = true;
    } else if (arg === "--language" || arg === "-l") {
      language = args[++i] ?? undefined;
    } else if (arg === "--stt-provider") {
      sttProvider = args[++i] ?? undefined;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/analyze.ts <source-files...> --project <project-dir>

Options:
  --project, -p      Project directory (required)
  --skip-stt         Skip speech-to-text stage
  --skip-vlm         Skip visual language model stage
  --skip-diarize     Skip pyannote speaker diarization (Groq STT only)
  --language, -l     ISO-639-1 language hint for STT (e.g. "ja", "en")
  --stt-provider     STT provider: "groq" or "openai" (auto-detected if omitted)
  --help, -h         Show this help
`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      sourceFiles.push(arg);
    }
  }

  if (!projectDir) {
    console.error("Error: --project <project-dir> is required");
    process.exit(1);
  }

  if (sourceFiles.length === 0) {
    console.error("Error: at least one source file is required");
    process.exit(1);
  }

  return { sourceFiles, projectDir, skipStt, skipVlm, skipDiarize, language, sttProvider };
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sourceFiles, projectDir, skipStt, skipVlm, skipDiarize, language, sttProvider } = parseArgs(process.argv);

  console.log(`[analyze] Project: ${path.resolve(projectDir)}`);
  console.log(`[analyze] Sources: ${sourceFiles.join(", ")}`);
  if (skipStt) console.log("[analyze] STT: skipped");
  if (skipVlm) console.log("[analyze] VLM: skipped");
  if (skipDiarize) console.log("[analyze] Diarization: skipped");
  if (language) console.log(`[analyze] Language: ${language}`);
  if (sttProvider) console.log(`[analyze] STT provider: ${sttProvider}`);

  // Create live VLM function if not skipped and API key is available
  let vlmFn;
  if (!skipVlm) {
    if (process.env.GEMINI_API_KEY) {
      vlmFn = createGeminiVlmFn();
      console.log("[analyze] VLM: using Gemini API");
    } else {
      console.warn("[analyze] WARNING: GEMINI_API_KEY not set, VLM stage will be skipped");
    }
  }

  const result = await runPipeline({
    sourceFiles,
    projectDir,
    skipStt,
    skipVlm,
    skipDiarize,
    vlmFn,
    sttLanguageOverride: language,
    sttProvider,
  });

  console.log("\n[analyze] Pipeline complete");
  console.log(`  Output: ${result.outputDir}`);
  console.log(`  Assets: ${result.assetsJson.items.length}`);
  console.log(`  Segments: ${result.segmentsJson.items.length}`);

  const gapCount = result.gapReport.entries.length;
  if (gapCount > 0) {
    const errors = result.gapReport.entries.filter((e) => e.severity === "error").length;
    const warnings = result.gapReport.entries.filter((e) => e.severity === "warning").length;
    console.log(`  Gaps: ${gapCount} (${errors} errors, ${warnings} warnings)`);
  } else {
    console.log("  Gaps: none");
  }
}

main().catch((err) => {
  console.error("[analyze] Fatal error:", err);
  process.exit(1);
});
