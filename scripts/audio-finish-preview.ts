#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveAudioFinishPolicy,
  type AudioFinishPreset,
} from "../runtime/audio/dialogue-finishing.js";
import { finishDialogueAudio } from "../runtime/audio/finish-runner.js";

const USAGE = `Usage:
  npx tsx scripts/audio-finish-preview.ts --project <dir> --input <wav> [options]

Options:
  --preset <dialogue-clean|loudness-only>  Default: dialogue-clean
  --output-dir <dir>                       Default: 06_review/audio-finish-preview/<timestamp>
  --duration <seconds>                     Preview duration per sample (default: 20)
  --json`;

interface Args {
  projectDir: string;
  inputPath: string;
  preset: Exclude<AudioFinishPreset, "none">;
  outputDir: string;
  durationSec: number;
  json: boolean;
}

export function parseAudioFinishPreviewArgs(argv: string[]): Args {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let inputPath: string | undefined;
  let preset: Exclude<AudioFinishPreset, "none"> = "dialogue-clean";
  let outputDir: string | undefined;
  let durationSec = 20;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--project") projectDir = required(values, ++index, flag);
    else if (flag === "--input") inputPath = required(values, ++index, flag);
    else if (flag === "--preset") {
      const value = required(values, ++index, flag);
      if (value !== "dialogue-clean" && value !== "loudness-only") {
        throw new Error("--preset must be dialogue-clean or loudness-only");
      }
      preset = value;
    } else if (flag === "--output-dir") outputDir = required(values, ++index, flag);
    else if (flag === "--duration") {
      durationSec = Number(required(values, ++index, flag));
      if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 120) {
        throw new Error("--duration must be between 0 and 120 seconds");
      }
    } else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    else throw new Error(`unknown argument: ${flag}\n${USAGE}`);
  }
  if (!projectDir) throw new Error(`--project is required\n${USAGE}`);
  if (!inputPath) throw new Error(`--input is required\n${USAGE}`);
  const absProject = path.resolve(projectDir);
  return {
    projectDir: absProject,
    inputPath: path.resolve(inputPath),
    preset,
    outputDir: path.resolve(outputDir ?? path.join(
      absProject,
      "06_review",
      "audio-finish-preview",
      timestampSlug(),
    )),
    durationSec,
    json,
  };
}

export async function runAudioFinishPreviewCli(argv = process.argv): Promise<number> {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const args = parseAudioFinishPreviewArgs(argv);
    assertProjectOutput(args.projectDir, args.outputDir);
    const policy = resolveAudioFinishPolicy({ preset: args.preset });
    if (!policy) throw new Error(`could not resolve audio finish preset: ${args.preset}`);
    if (fs.existsSync(args.outputDir)) {
      throw new Error(`audio preview output already exists: ${args.outputDir}`);
    }
    fs.mkdirSync(args.outputDir, { recursive: true });
    const masteredPath = path.join(args.outputDir, "mastered.wav");
    const finishReport = await finishDialogueAudio({
      inputPath: args.inputPath,
      outputPath: masteredPath,
      policy,
    });
    const sourceDurationSec = probeDuration(args.inputPath);
    const starts = autoSegmentStarts(sourceDurationSec, args.durationSec);
    const segments = [];
    for (const [index, startSec] of starts.entries()) {
      const ordinal = String(index + 1).padStart(2, "0");
      const label = ["intro", "middle", "ending"][index];
      const beforePath = path.join(args.outputDir, `${ordinal}-${label}-before.m4a`);
      const afterPath = path.join(args.outputDir, `${ordinal}-${label}-after.m4a`);
      await extractPreview(args.inputPath, beforePath, startSec, args.durationSec);
      await extractPreview(masteredPath, afterPath, startSec, args.durationSec);
      segments.push({
        label,
        start_sec: startSec,
        duration_sec: args.durationSec,
        before: artifact(args.projectDir, beforePath),
        after: artifact(args.projectDir, afterPath),
      });
    }
    const manifest = {
      version: "audio-finish-preview/v1",
      project_id: readTimelineProjectId(args.projectDir),
      created_at: new Date().toISOString(),
      preset: args.preset,
      policy,
      source: artifact(args.projectDir, args.inputPath, true),
      mastered: artifact(args.projectDir, masteredPath),
      measurements: {
        before: finishReport.premaster_measurement,
        after: finishReport.output_measurement,
      },
      segments,
    };
    const manifestPath = path.join(args.outputDir, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const result = {
      manifest_path: manifestPath,
      manifest_sha256: hashFile(manifestPath),
      mastered_path: masteredPath,
      segments,
      measurements: manifest.measurements,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : [
      "[audio-finish-preview] complete",
      `manifest: ${manifestPath}`,
      `manifest_sha256: ${result.manifest_sha256}`,
      `before: ${finishReport.premaster_measurement.input_i} LUFS`,
      `after: ${finishReport.output_measurement.input_i} LUFS`,
    ].join("\n"));
    return 0;
  } catch (error) {
    console.error(`[audio-finish-preview] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function autoSegmentStarts(totalSec: number, durationSec: number): number[] {
  const maxStart = Math.max(0, totalSec - durationSec);
  return [
    Math.min(maxStart, 30),
    Math.min(maxStart, Math.max(0, totalSec / 2 - durationSec / 2)),
    Math.min(maxStart, Math.max(0, totalSec - durationSec - 30)),
  ].map((value) => Number(value.toFixed(3)));
}

function extractPreview(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", [
      "-v", "error",
      "-y",
      "-ss", String(startSec),
      "-t", String(durationSec),
      "-i", inputPath,
      "-vn",
      "-c:a", "aac",
      "-b:a", "192k",
      outputPath,
    ], { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`preview extraction failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}

function probeDuration(filePath: string): number {
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ], { encoding: "utf8" });
  const duration = Number((JSON.parse(output) as { format?: { duration?: string } }).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("could not probe audio duration");
  return duration;
}

function artifact(projectDir: string, filePath: string, allowExternal = false): {
  path: string;
  sha256: string;
  size_bytes: number;
} {
  const absPath = path.resolve(filePath);
  const relative = path.relative(projectDir, absPath);
  if (!allowExternal && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`preview artifact escaped project root: ${absPath}`);
  }
  return {
    path: allowExternal && (relative.startsWith("..") || path.isAbsolute(relative))
      ? absPath
      : relative.split(path.sep).join("/"),
    sha256: hashFile(absPath),
    size_bytes: fs.statSync(absPath).size,
  };
}

function readTimelineProjectId(projectDir: string): string {
  const timeline = JSON.parse(
    fs.readFileSync(path.join(projectDir, "05_timeline", "timeline.json"), "utf8"),
  ) as { project_id?: unknown };
  if (typeof timeline.project_id !== "string" || !timeline.project_id.trim()) {
    throw new Error("timeline project_id is missing");
  }
  return timeline.project_id;
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertProjectOutput(projectDir: string, outputDir: string): void {
  const relative = path.relative(path.resolve(projectDir), path.resolve(outputDir));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  throw new Error(`audio preview output must be inside the project: ${outputDir}`);
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  runAudioFinishPreviewCli().then((code) => { process.exitCode = code; });
}
