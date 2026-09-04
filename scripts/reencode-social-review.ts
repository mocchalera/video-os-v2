#!/usr/bin/env npx tsx

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildReencodeGeneration,
  prepareImmutableReencode,
  writeReencodeReceipt,
} from "../runtime/review/reencode-generation.js";
import {
  verifyLatestGeneration,
  verifyReviewReadyReceipt,
  type SocialReviewGeneration,
  type SocialReviewGenerationReceipt,
} from "../runtime/review/social-review-generation.js";

const execFileAsync = promisify(execFile);

export interface ReencodeSocialReviewArgs { projectDir: string; maxWidth: number; crf: number }

export function parseReencodeSocialReviewArgs(argv: string[]): ReencodeSocialReviewArgs {
  let projectDir: string | undefined;
  let maxWidth = 720;
  let crf = 23;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--project" && value) { projectDir = value; index += 1; }
    else if (arg === "--max-width" && value) { maxWidth = Number(value); index += 1; }
    else if (arg === "--crf" && value) { crf = Number(value); index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!projectDir || !Number.isInteger(maxWidth) || !Number.isInteger(crf)) {
    throw new Error("Usage: npm run social-review:reencode -- --project <dir> [--max-width 720] [--crf 23]");
  }
  return { projectDir: path.resolve(projectDir), maxWidth, crf };
}

export async function reencodeSocialReview(args: ReencodeSocialReviewArgs): Promise<Record<string, unknown>> {
  const latest = verifyLatestGeneration(args.projectDir);
  const generationDir = path.join(args.projectDir, "09_output", "social-review", "generations", latest.generation_id.slice(7));
  const receiptPath = path.join(generationDir, "review-ready-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as SocialReviewGenerationReceipt;
  if (!receipt.review_ready) throw new Error("source social-review generation is not review-ready");
  const source: SocialReviewGeneration = {
    version: "social-review-generation/v1",
    project_id: receipt.project_id,
    project_dir: args.projectDir,
    generation_id: receipt.generation_id,
    generation_dir: generationDir,
    output_path: path.join(args.projectDir, receipt.output.path),
    receipt_path: receiptPath,
    inputs: receipt.inputs,
    input_files: receipt.input_files,
    source_input_attestation: JSON.parse(fs.readFileSync(
      path.join(args.projectDir, receipt.source_input_attestation.path),
      "utf8",
    )) as unknown,
  };
  verifyReviewReadyReceipt(source, receipt);
  const generation = buildReencodeGeneration({
    sourceGeneration: source,
    sourceReceipt: receipt,
    transform: { container: "mp4", video_codec: "h264", max_width: args.maxWidth, crf: args.crf },
  });
  const prepared = prepareImmutableReencode(generation);
  if (prepared.status === "reused") return prepared.receipt! as unknown as Record<string, unknown>;
  await execFileAsync("ffmpeg", [
    "-nostdin", "-v", "error", "-xerror", "-i", source.output_path,
    "-vf", `scale='min(${args.maxWidth},iw)':-2`, "-c:v", "libx264", "-crf", String(args.crf),
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", generation.output_path,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const result = generation.buildReceipt();
  writeReencodeReceipt(generation, result);
  return result as unknown as Record<string, unknown>;
}

async function main(): Promise<void> {
  try { console.log(JSON.stringify(await reencodeSocialReview(parseReencodeSocialReviewArgs(process.argv)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
