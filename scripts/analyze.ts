#!/usr/bin/env npx tsx
/**
 * CLI entrypoint for the M2 analysis pipeline.
 *
 * Usage:
 *   npx tsx scripts/analyze.ts <source-files...> --project <project-dir>
 *   npx tsx scripts/analyze.ts video1.mp4 video2.mov --project projects/my-project
 *   npx tsx scripts/analyze.ts video.mp4 --project projects/test --skip-stt --skip-vlm
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig(); // fallback: .env

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runPipeline } from "../runtime/pipeline/ingest.js";
import { createGeminiVlmFn } from "../runtime/connectors/gemini-vlm.js";
import { runPreflight } from "./preflight.js";

// ── Arg Parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  sourceFiles: string[];
  projectDir: string;
  skipStt: boolean;
  skipVlm: boolean;
  skipDiarize: boolean;
  skipPeak: boolean;
  skipMediaLink: boolean;
  skipPreflight: boolean;
  language: string | undefined;
  sttProvider: string | undefined;
  contentHint: string | undefined;
} {
  const args = argv.slice(2); // skip node + script path
  const sourceFiles: string[] = [];
  let projectDir = "";
  let skipStt = false;
  let skipVlm = false;
  let skipDiarize = false;
  let skipPeak = false;
  let skipMediaLink = false;
  let skipPreflight = false;
  let language: string | undefined;
  let sttProvider: string | undefined;
  let contentHint: string | undefined;

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
    } else if (arg === "--skip-peak") {
      skipPeak = true;
    } else if (arg === "--skip-media-link") {
      skipMediaLink = true;
    } else if (arg === "--skip-preflight") {
      skipPreflight = true;
    } else if (arg === "--language" || arg === "-l") {
      language = args[++i] ?? undefined;
    } else if (arg === "--stt-provider") {
      sttProvider = args[++i] ?? undefined;
    } else if (arg === "--content-hint") {
      contentHint = args[++i] ?? undefined;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/analyze.ts <source-files...> --project <project-dir>

Options:
  --project, -p      Project directory (required)
  --skip-stt         Skip speech-to-text stage
  --skip-vlm         Skip visual language model stage
  --skip-diarize     Skip pyannote speaker diarization (Groq STT only)
  --skip-peak        Skip VLM peak detection stage
  --skip-media-link  Skip 02_media symlink generation
  --skip-preflight   Skip pre-flight environment checks
  --language, -l     ISO-639-1 language hint for STT (e.g. "ja", "en")
  --stt-provider     STT provider: "groq" or "openai" (auto-detected if omitted)
  --content-hint     Content context for VLM (e.g. "子供の自転車練習")
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

  return {
    sourceFiles,
    projectDir,
    skipStt,
    skipVlm,
    skipDiarize,
    skipPeak,
    skipMediaLink,
    skipPreflight,
    language,
    sttProvider,
    contentHint,
  };
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const {
    sourceFiles,
    projectDir,
    skipStt,
    skipVlm,
    skipDiarize,
    skipPeak,
    skipMediaLink,
    skipPreflight,
    language,
    sttProvider,
    contentHint,
  } = parseArgs(process.argv);

  // ── Pre-flight checks ──────────────────────────────────────────
  if (!skipPreflight) {
    // Use the directory of the first source file as the source folder
    const sourceFolder = path.dirname(path.resolve(sourceFiles[0]));
    console.log("[analyze] Running pre-flight checks...");
    const preflight = runPreflight(sourceFolder);
    for (const check of preflight.checks) {
      const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
      console.log(`  ${icon} ${check.name}: ${check.detail}`);
    }
    if (!preflight.ok) {
      console.error("[analyze] Pre-flight failed. Fix the issues above or use --skip-preflight.");
      process.exit(1);
    }
    console.log("[analyze] Pre-flight passed.\n");
  }

  console.log(`[analyze] Project: ${path.resolve(projectDir)}`);
  console.log(`[analyze] Sources: ${sourceFiles.join(", ")}`);
  if (skipStt) console.log("[analyze] STT: skipped");
  if (skipVlm) console.log("[analyze] VLM: skipped");
  if (skipDiarize) console.log("[analyze] Diarization: skipped");
  if (skipPeak) console.log("[analyze] Peak detection: skipped");
  if (skipMediaLink) console.log("[analyze] Media links: skipped");
  if (language) console.log(`[analyze] Language: ${language}`);
  if (sttProvider) console.log(`[analyze] STT provider: ${sttProvider}`);
  if (contentHint) console.log(`[analyze] Content hint: ${contentHint}`);

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
    skipPeak,
    vlmFn,
    sttLanguageOverride: language,
    sttProvider,
    contentHint,
    skipMediaLink,
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

  if (result.mediaSourceMapPath) {
    console.log(`  Media links: ${result.mediaSourceMap?.items.length ?? 0} mapped`);
    console.log(`  Source map: ${result.mediaSourceMapPath}`);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    console.error("[analyze] Fatal error:", err);
    process.exit(1);
  });
}

export { parseArgs };
