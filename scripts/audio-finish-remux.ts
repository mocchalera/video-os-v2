#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { finishAndRemuxVideo } from "../runtime/audio/finish-remux.js";
import { resolveAudioFinishPolicy } from "../runtime/audio/dialogue-finishing.js";
import {
  runCaptionFinalize,
  type CaptionFinalizeReceipt,
} from "../runtime/caption/caption-finalize.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { assertFinalRenderApprovalCurrent } from "../runtime/packaging/final-render-approval.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";

export const AUDIO_FINISH_REMUX_USAGE = `Usage:
  npm run audio-finish-remux -- --project <dir> --source-receipt <caption-finalize-receipt.json> [options]

Options:
  --output-root <dir>  Default: 07_package/audio-finish-remux
  --finalize           Activate a new caption-finalize generation after the video-preserving remux
  --created-at <ISO>   Deterministic receipt timestamp
  --json               Print JSON
  -h, --help           Show this help`;

interface Args {
  projectDir: string;
  sourceReceiptPath: string;
  outputRoot?: string;
  finalize: boolean;
  createdAt?: string;
  json: boolean;
}

export function parseAudioFinishRemuxArgs(argv: string[]): Args {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let sourceReceiptPath: string | undefined;
  let outputRoot: string | undefined;
  let finalize = false;
  let createdAt: string | undefined;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--project") projectDir = required(values, ++index, flag);
    else if (flag === "--source-receipt") sourceReceiptPath = required(values, ++index, flag);
    else if (flag === "--output-root") outputRoot = required(values, ++index, flag);
    else if (flag === "--created-at") createdAt = required(values, ++index, flag);
    else if (flag === "--finalize") finalize = true;
    else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") throw new Error(AUDIO_FINISH_REMUX_USAGE);
    else throw new Error(`unknown argument: ${flag}\n${AUDIO_FINISH_REMUX_USAGE}`);
  }
  if (!projectDir) throw new Error(`--project is required\n${AUDIO_FINISH_REMUX_USAGE}`);
  if (!sourceReceiptPath) throw new Error(`--source-receipt is required\n${AUDIO_FINISH_REMUX_USAGE}`);
  return {
    projectDir: path.resolve(projectDir),
    sourceReceiptPath: path.resolve(sourceReceiptPath),
    outputRoot: outputRoot ? path.resolve(outputRoot) : undefined,
    finalize,
    createdAt,
    json,
  };
}

export async function runAudioFinishRemuxCli(argv = process.argv): Promise<number> {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    console.log(AUDIO_FINISH_REMUX_USAGE);
    return 0;
  }
  try {
    const args = parseAudioFinishRemuxArgs(argv);
    const sourceReceipt = JSON.parse(
      fs.readFileSync(args.sourceReceiptPath, "utf8"),
    ) as CaptionFinalizeReceipt;
    const receiptValidation = validateAgainstSchema(
      sourceReceipt,
      "caption-finalize-receipt.schema.json",
    );
    if (!receiptValidation.valid) {
      throw new Error(`source caption-finalize receipt is invalid: ${receiptValidation.errors.join("; ")}`);
    }
    const sourceFinalPath = projectArtifactPath(
      args.projectDir,
      sourceReceipt.artifacts.final_video.path,
    );
    if (computeSha256(sourceFinalPath) !== sourceReceipt.artifacts.final_video.sha256) {
      throw new Error("source caption-finalize final video hash mismatch");
    }

    const finalApproval = assertFinalRenderApprovalCurrent(args.projectDir);
    if (sourceReceipt.final_render_approval_sha256 === finalApproval.sha256) {
      throw new Error(
        "source generation is already bound to the current final-render approval; refusing possible double MA",
      );
    }
    const timeline = JSON.parse(
      fs.readFileSync(path.join(args.projectDir, "05_timeline", "timeline.json"), "utf8"),
    ) as { metadata?: { audio_finish?: unknown } };
    const policy = resolveAudioFinishPolicy(timeline.metadata?.audio_finish);
    if (!policy) throw new Error("timeline does not declare dialogue-clean or loudness-only audio_finish");
    if (
      finalApproval.approval.checklist.audio.decision !== policy.preset
      || finalApproval.approval.checklist.audio.preview_reviewed !== true
    ) {
      throw new Error("current final-render approval does not authorize the requested audio finish");
    }

    const remux = await finishAndRemuxVideo({
      sourceVideoPath: sourceFinalPath,
      outputRoot: args.outputRoot
        ?? path.join(args.projectDir, "07_package", "audio-finish-remux"),
      policy,
      createdAt: args.createdAt,
    });
    const finalized = args.finalize
      ? await runCaptionFinalize(args.projectDir, {
          suppliedFinalPath: remux.outputPath,
          suppliedFinalReceiptPath: args.sourceReceiptPath,
          createdAt: args.createdAt,
        })
      : undefined;
    const result = {
      success: true,
      reused: remux.reused,
      candidate_path: remux.outputPath,
      remux_receipt_path: remux.receiptPath,
      video_stream_preserved: true,
      ...(finalized
        ? {
            finalized: true,
            generation_id: finalized.generationId,
            active_delivery_path: finalized.activeDeliveryPath,
          }
        : { finalized: false }),
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : [
      `[audio-finish-remux] ${remux.reused ? "reused" : "completed"}`,
      `candidate: ${remux.outputPath}`,
      "video stream: preserved",
      finalized ? `activated generation: ${finalized.generationId}` : "activation: not requested",
    ].join("\n"));
    return 0;
  } catch (error) {
    console.error(`[audio-finish-remux] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function projectArtifactPath(projectDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("source receipt artifact path must be project-relative");
  const projectRoot = path.resolve(projectDir);
  const resolved = path.resolve(projectRoot, relativePath);
  if (!resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("source receipt artifact escaped the project");
  }
  if (!fs.existsSync(resolved)) throw new Error(`source receipt artifact is missing: ${resolved}`);
  return resolved;
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runAudioFinishRemuxCli().then((code) => { process.exitCode = code; });
}
