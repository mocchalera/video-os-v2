#!/usr/bin/env tsx
import { finishPromoCut } from "../runtime/render/promo-finisher.js";

interface CliOptions {
  projectDir?: string;
  timelinePath?: string;
  outputPath?: string;
  workDir?: string;
  endingTailSec?: number;
  endingFadeSec?: number;
  captionMaxChars?: number;
  noSubtitles?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--project":
        options.projectDir = requireValue(arg, next);
        i += 1;
        break;
      case "--timeline":
        options.timelinePath = requireValue(arg, next);
        i += 1;
        break;
      case "--output":
        options.outputPath = requireValue(arg, next);
        i += 1;
        break;
      case "--work-dir":
        options.workDir = requireValue(arg, next);
        i += 1;
        break;
      case "--ending-tail-sec":
        options.endingTailSec = parseNumber(arg, next);
        i += 1;
        break;
      case "--ending-fade-sec":
        options.endingFadeSec = parseNumber(arg, next);
        i += 1;
        break;
      case "--caption-max-chars":
        options.captionMaxChars = parseNumber(arg, next);
        i += 1;
        break;
      case "--no-subtitles":
        options.noSubtitles = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNumber(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} requires a number`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(`Usage:
  npm run promo-finish -- --project projects/<project-id> [options]

Options:
  --timeline <path>             Timeline JSON path. Defaults to 05_timeline/timeline.json.
  --output <path>               Output MP4 path. Defaults to 09_output/promo-finished.mp4.
  --work-dir <path>             Working artifact directory.
  --ending-tail-sec <number>    Source tail to preserve before fade. Default: 0.8.
  --ending-fade-sec <number>    Audio/video fade-out duration. Default: 0.8.
  --caption-max-chars <number>  Max characters per subtitle chunk. Default: 26.
  --no-subtitles                Render fade-only output.
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.projectDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const result = await finishPromoCut({
    projectDir: options.projectDir,
    timelinePath: options.timelinePath,
    outputPath: options.outputPath,
    workDir: options.workDir,
    endingTailSec: options.endingTailSec,
    endingFadeSec: options.endingFadeSec,
    captionMaxChars: options.captionMaxChars,
    subtitles: !options.noSubtitles,
  });

  console.log(`promo finish complete:
  output: ${result.outputPath}
  duration_sec: ${result.durationSec.toFixed(3)}
  captions: ${result.captionSummary.captionCount}
  ending_tail_frames: ${result.tailSummary.addedFrames}
  base: ${result.basePath}
  subtitles: ${result.assPath}
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
