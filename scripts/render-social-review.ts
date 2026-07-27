#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ASS_HEAVY_VIDEO_FONT,
} from "../editor/shared/font-contract.js";
import { resolveAudioFinishPolicy } from "../runtime/audio/dialogue-finishing.js";
import { finishDialogueAudio } from "../runtime/audio/finish-runner.js";
import type { CaptionOverlay, TimelineIR } from "../runtime/compiler/types.js";
import {
  loadContentRenderPlan,
  type ContentRenderPlan,
} from "../runtime/content/render-plan.js";
import { renderHyperFramesContentLayer } from "../runtime/content/hyperframes-renderer.js";
import type {
  ContentRendererId,
  CreativeCompositeStage,
} from "../runtime/content/types.js";
import { verifyBundledFont } from "../runtime/fonts/bundled-font.js";
import {
  getTimelineFps,
  readTimeline,
} from "../runtime/render/assembler.js";
import { composeFinalVisuals, type FinalVisualLayer } from "../runtime/render/final-visual-compositor.js";
import {
  buildAssSubtitleFile,
  type AssSubtitleStyleOptions,
} from "../runtime/render/promo-finisher.js";
import { renderRemotionContentLayer } from "../runtime/render/remotion/render-remotion.js";
import { renderRoughCut } from "./render-rough-cut.js";

const execFileAsync = promisify(execFile);

interface CaptionPlan {
  version?: string;
  captions: CaptionOverlay[];
}

export interface SocialReviewArgs {
  projectDir: string;
  outputPath?: string;
  workDir?: string;
  captionPlanPath: string;
}

export interface SocialVisualLayerRequest {
  renderer: Exclude<ContentRendererId, "ffmpeg">;
  compositeStage: CreativeCompositeStage;
  zIndex: number;
  elementIds: string[];
}

interface SocialVisualLayerRenderers {
  hyperframes: typeof renderHyperFramesContentLayer;
  remotion: typeof renderRemotionContentLayer;
}

interface RenderedSocialVisualLayers {
  layers: FinalVisualLayer[];
  receipts: Array<{
    renderer: SocialVisualLayerRequest["renderer"];
    composite_stage: CreativeCompositeStage;
    receipt_path: string;
    element_ids: string[];
  }>;
}

const USAGE = `Usage:
  npm run social-review -- --project <dir> --captions <plan.json> [--output <mp4>] [--work-dir <dir>]

Renders a review-only social preview from canonical timeline cuts, registered
content elements, authored captions, and dialogue audio. It does not approve or
package a final deliverable.`;

export function parseSocialReviewArgs(argv: string[]): SocialReviewArgs {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let outputPath: string | undefined;
  let workDir: string | undefined;
  let captionPlanPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") projectDir = required(values, ++index, arg);
    else if (arg === "--output") outputPath = required(values, ++index, arg);
    else if (arg === "--work-dir") workDir = required(values, ++index, arg);
    else if (arg === "--captions") captionPlanPath = required(values, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (!projectDir || !captionPlanPath) throw new Error(USAGE);
  return {
    projectDir: path.resolve(projectDir),
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
    workDir: workDir ? path.resolve(workDir) : undefined,
    captionPlanPath: path.resolve(captionPlanPath),
  };
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function timelineVisualDurationFrames(timeline: TimelineIR): number {
  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  return Math.max(
    1,
    ...[...timeline.tracks.video, ...(tracks.overlay ?? [])]
      .flatMap((track) => track.clips)
      .map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames),
  );
}

export function validateCaptionPlan(plan: CaptionPlan, durationFrames: number): CaptionOverlay[] {
  if (!Array.isArray(plan.captions) || plan.captions.length === 0) {
    throw new Error("Caption plan must contain at least one caption");
  }
  const captions = [...plan.captions].sort((left, right) =>
    left.in_frame - right.in_frame || left.out_frame - right.out_frame
  );
  let previousOut = 0;
  for (const [index, caption] of captions.entries()) {
    if (!caption.text?.trim()) throw new Error(`Caption ${index} has empty text`);
    if (!Number.isInteger(caption.in_frame) || !Number.isInteger(caption.out_frame)) {
      throw new Error(`Caption ${index} frame bounds must be integers`);
    }
    if (caption.in_frame < previousOut || caption.out_frame <= caption.in_frame) {
      throw new Error(`Caption ${index} overlaps or has an invalid range`);
    }
    if (caption.out_frame > durationFrames) {
      throw new Error(`Caption ${index} exceeds timeline duration ${durationFrames}`);
    }
    previousOut = caption.out_frame;
  }
  return captions;
}

export function socialReviewCaptionStyle(
  width: number,
  height: number,
): AssSubtitleStyleOptions {
  return {
    fontName: ASS_HEAVY_VIDEO_FONT.family,
    playResX: width,
    playResY: height,
    fontSize: width === 1080 ? 64 : Math.round(width * 0.0593),
    marginV: height === 1920 ? 300 : Math.round(height * 0.15625),
    borderStyle: 3,
    outline: width === 1080 ? 12 : Math.max(8, Math.round(width * 0.0111)),
    backColor: "&H500B2434",
  };
}

export function planSocialVisualLayers(
  plan: ContentRenderPlan,
): SocialVisualLayerRequest[] {
  const groups = new Map<string, SocialVisualLayerRequest>();
  for (const element of plan.visual_elements ?? []) {
    if (element.renderer === "ffmpeg" || element.requires_base_frame) continue;
    const key = `${element.renderer}:${element.composite_stage}`;
    const existing = groups.get(key);
    if (existing) {
      existing.zIndex = Math.min(existing.zIndex, element.z_index);
      existing.elementIds.push(element.element_id);
      continue;
    }
    groups.set(key, {
      renderer: element.renderer,
      compositeStage: element.composite_stage,
      zIndex: element.z_index,
      elementIds: [element.element_id],
    });
  }
  return [...groups.values()]
    .map((request) => ({
      ...request,
      elementIds: [...request.elementIds].sort((left, right) => left.localeCompare(right, "en")),
    }))
    .sort((left, right) =>
      (left.compositeStage === right.compositeStage
        ? left.zIndex - right.zIndex
        : left.compositeStage === "under_caption" ? -1 : 1) ||
      left.renderer.localeCompare(right.renderer, "en")
    );
}

export async function renderSocialVisualLayers(
  timelinePath: string,
  outputDir: string,
  renderers: SocialVisualLayerRenderers = {
    hyperframes: renderHyperFramesContentLayer,
    remotion: renderRemotionContentLayer,
  },
): Promise<RenderedSocialVisualLayers> {
  const plan = loadContentRenderPlan(timelinePath);
  if (plan.issues.length > 0) {
    throw new Error(
      `Social content plan is invalid: ${plan.issues.map((issue) => `${issue.clip_id}: ${issue.message}`).join("; ")}`,
    );
  }
  const layers: FinalVisualLayer[] = [];
  const receipts: RenderedSocialVisualLayers["receipts"] = [];
  for (const request of planSocialVisualLayers(plan)) {
    const rendered = request.renderer === "hyperframes"
      ? await renderers.hyperframes({
          timelinePath,
          outputDir,
          compositeStage: request.compositeStage,
        })
      : await renderers.remotion({
          timelinePath,
          outputDir,
          compositeStage: request.compositeStage,
          elementIds: request.elementIds,
        });
    if (!rendered) {
      throw new Error(
        `${request.renderer} returned no layer for ${request.elementIds.join(", ")}`,
      );
    }
    layers.push({
      path: rendered.overlayPath,
      renderer: request.renderer,
      compositeStage: request.compositeStage,
      zIndex: request.zIndex,
      elementIds: request.elementIds,
    });
    receipts.push({
      renderer: request.renderer,
      composite_stage: request.compositeStage,
      receipt_path: rendered.receiptPath,
      element_ids: request.elementIds,
    });
  }
  return { layers, receipts };
}

function sha256(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function hasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    filePath,
  ]);
  return stdout.trim().length > 0;
}

async function muxReviewAudio(
  visualPath: string,
  audioSourcePath: string,
  outputPath: string,
  durationSec: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!(await hasAudio(audioSourcePath))) {
    fs.copyFileSync(visualPath, outputPath);
    return;
  }
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", visualPath,
    "-i", audioSourcePath,
    "-filter_complex", `[1:a]apad,atrim=duration=${durationSec.toFixed(9)}[a]`,
    "-map", "0:v:0",
    "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ], { maxBuffer: 100 * 1024 * 1024 });
}

export async function renderSocialReview(args: SocialReviewArgs): Promise<Record<string, unknown>> {
  const timelinePath = path.join(args.projectDir, "05_timeline", "timeline.json");
  const timeline = readTimeline(timelinePath);
  const fps = getTimelineFps(timeline);
  const durationFrames = timelineVisualDurationFrames(timeline);
  const durationSec = durationFrames / fps;
  const plan = JSON.parse(fs.readFileSync(args.captionPlanPath, "utf8")) as CaptionPlan;
  const captions = validateCaptionPlan(plan, durationFrames);
  const workDir = args.workDir ?? path.join(args.projectDir, "09_output", "social-review-work");
  const outputPath = args.outputPath ?? path.join(args.projectDir, "09_output", "social-review.mp4");
  const basePath = path.join(workDir, "base-dialogue.mp4");
  const assPath = path.join(workDir, "captions.ass");
  const visualPath = path.join(workDir, "visual.mp4");
  const masteredDialoguePath = path.join(workDir, "mastered-dialogue.wav");
  const layerDir = path.join(workDir, "layers");
  fs.mkdirSync(workDir, { recursive: true });

  await renderRoughCut({
    projectPath: args.projectDir,
    outputPath: basePath,
    noAudio: false,
    deferEndingFade: true,
  });
  const audioFinishPolicy = resolveAudioFinishPolicy(timeline.metadata?.audio_finish);
  const audioFinishReport = audioFinishPolicy
    ? await finishDialogueAudio({
        inputPath: basePath,
        outputPath: masteredDialoguePath,
        policy: audioFinishPolicy,
      })
    : undefined;

  const fontPaths = verifyBundledFont();
  fs.writeFileSync(
    assPath,
    buildAssSubtitleFile(
      captions,
      fps,
      socialReviewCaptionStyle(timeline.sequence.width, timeline.sequence.height),
    ),
    "utf8",
  );

  const renderedLayers = await renderSocialVisualLayers(timelinePath, layerDir);
  await composeFinalVisuals({
    baseVideoPath: basePath,
    layers: renderedLayers.layers,
    assPath,
    fontsDir: fontPaths.fontsDir,
    outputPath: visualPath,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    fpsNum: timeline.sequence.fps_num,
    fpsDen: timeline.sequence.fps_den,
    durationFrames,
  });
  await muxReviewAudio(
    visualPath,
    audioFinishReport?.output_path ?? basePath,
    outputPath,
    durationSec,
  );

  const report = {
    version: "social-review-render/v2",
    project: args.projectDir,
    timeline_path: timelinePath,
    timeline_version: timeline.version,
    caption_plan_path: args.captionPlanPath,
    caption_count: captions.length,
    duration_frames: durationFrames,
    duration_sec: durationSec,
    fps_num: timeline.sequence.fps_num,
    fps_den: timeline.sequence.fps_den,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    layer_count: renderedLayers.layers.length,
    visual_layer_receipts: renderedLayers.receipts,
    caption_font: {
      family: ASS_HEAVY_VIDEO_FONT.family,
      weight: ASS_HEAVY_VIDEO_FONT.weight,
      path: fontPaths.assHeavyFontPath,
      sha256: sha256(fontPaths.assHeavyFontPath),
    },
    audio_finish: audioFinishReport ? {
      preset: audioFinishReport.policy.preset,
      target_lufs: audioFinishReport.policy.loudness_target_lufs,
      target_true_peak_dbtp: audioFinishReport.policy.true_peak_target_dbtp,
      before: audioFinishReport.premaster_measurement,
      after: audioFinishReport.output_measurement,
    } : null,
    output_path: outputPath,
    output_sha256: sha256(outputPath),
    review_only: true,
  };
  fs.writeFileSync(
    path.join(workDir, "social-review-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

async function main(): Promise<void> {
  try {
    const report = await renderSocialReview(parseSocialReviewArgs(process.argv));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) void main();
