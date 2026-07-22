/**
 * Render Pipeline Orchestration
 *
 * Stepwise render pipeline for M4 packaging:
 *   assembly -> demux -> caption_burn -> audio_master -> final mux
 *
 * All ffmpeg calls use execFile wrapped in Promises with stderr logging.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertTimelineRenderSupported } from "./media-kind-guard.js";
import { resolveCanonicalRenderInputs } from "./canonical-render-input.js";
import { assessRenderArtifactFreshness } from "./source-input-attestation.js";

// FATAL-1 (Phase 5 review R1): both preview and final must serialize the
// video filter graph through the same shared builder so the byte-identical
// parity guarantee actually holds. The runtime previously had a bespoke
// scale+pad helper which diverged from preview the moment any clip carried
// a zoom/crop/effect. We now delegate every "fit" call to the shared
// filtergraph builder via a synthetic no-transform RenderVideoClip.
import {
  buildVideoClipFilterString,
} from "../../editor/shared/filtergraph.js";
import type { RenderVideoClip } from "../../editor/shared/render-spec.js";
import { INTERMEDIATE_X264, x264Args } from "../../editor/shared/encode-profiles.js";
import {
  buildAssDocument,
  parseSrtCues,
  resolveCaptionStylePreset,
  type AssCaptionCue,
} from "../../editor/shared/caption-style-tokens.js";
import {
  produceAssembly,
  resolveAssemblyEngine,
} from "./assembly-orchestrator.js";
import type { AssemblyEngine } from "./assembly-orchestrator.js";
import { resolveBundledFontPaths } from "../fonts/bundled-font.js";
import { assessMusicAssetEligibility } from "../music/asset-eligibility.js";
import { applyMusicMixProfile, type MusicCuesDoc } from "../audio/music-cues.js";
import { timelineEmbeddedMusicAssetIds } from "../audio/timeline-music.js";
import { renderHyperFramesContentOverlay } from "../content/hyperframes-renderer.js";
import {
  resolveProjectRenderRoute,
  writeRenderRouteReceipt,
  type RenderRouteDecision,
} from "./route-resolver.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RenderPipelineOptions {
  projectDir: string;
  timelinePath: string;
  captionApprovalPath?: string;
  musicCuesPath?: string;
  assemblyPath?: string; // Pre-built assembly.mp4 (skip Remotion step)
  /** Alternate engine if assemblyPath is not pre-built */
  assemblyEngine?: AssemblyEngine;
  /** Engine input: asset_id -> source file map */
  sourceMap?: Record<string, string>;
  /** Where Remotion should write assembly.mp4 */
  assemblyOutputPath?: string;
  /** Optional bundle cache dir (Remotion) */
  bundleCacheDir?: string;
  /** Pre-resolved capability route from the package entrypoint. */
  renderRouteDecision?: RenderRouteDecision;
  captionPolicy: {
    language: string;
    delivery_mode: "burn_in" | "sidecar" | "both";
    source: "transcript" | "authored" | "none";
    styling_class: string;
  };
  outputDir: string; // 07_package/
  fps: number;
}

export interface RenderPipelineResult {
  assemblyPath: string;
  rawVideoPath: string;
  rawDialoguePath: string;
  finalMixPath: string;
  finalVideoPath: string;
  sidecarPaths: string[];
  logs: Record<string, string>;
  audioMixReportPath: string;
  renderRouteReceiptPath: string;
}

export const FINAL_AUDIO_SAMPLE_RATE_HZ = 48_000;

// ── Helpers ────────────────────────────────────────────────────────

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeLog(logsDir: string, name: string, content: string): string {
  const logPath = path.join(logsDir, `${name}.log`);
  fs.writeFileSync(logPath, content, "utf-8");
  return logPath;
}

interface TimelineSequenceConfig {
  width: number;
  height: number;
  output_aspect_ratio?: string;
}

function readTimelineSequenceConfig(timelinePath: string): TimelineSequenceConfig {
  const raw = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
    sequence?: { width?: number; height?: number; output_aspect_ratio?: string };
  };

  const width = raw.sequence?.width;
  const height = raw.sequence?.height;
  if (!width || !height) {
    throw new Error(`Timeline sequence width/height missing: ${timelinePath}`);
  }

  return {
    width,
    height,
    output_aspect_ratio: raw.sequence?.output_aspect_ratio,
  };
}

export function readTimelineDurationSeconds(timelinePath: string): number | undefined {
  const raw = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
    sequence?: { fps_num?: number; fps_den?: number };
    tracks?: Record<string, Array<{
      clips?: Array<{
        timeline_in_frame?: number;
        timeline_duration_frames?: number;
      }>;
    }>>;
  };
  const fpsNum = raw.sequence?.fps_num;
  const fpsDen = raw.sequence?.fps_den ?? 1;
  if (!fpsNum || !Number.isFinite(fpsNum) || !Number.isFinite(fpsDen) || fpsDen <= 0) {
    return undefined;
  }

  let maxOutFrame = 0;
  for (const tracks of Object.values(raw.tracks ?? {})) {
    for (const track of tracks ?? []) {
      for (const clip of track.clips ?? []) {
        const inFrame = clip.timeline_in_frame ?? 0;
        const durationFrames = clip.timeline_duration_frames ?? 0;
        if (!Number.isFinite(inFrame) || !Number.isFinite(durationFrames)) continue;
        maxOutFrame = Math.max(maxOutFrame, inFrame + durationFrames);
      }
    }
  }

  return maxOutFrame > 0 ? maxOutFrame / (fpsNum / fpsDen) : undefined;
}

/**
 * Build the fit filter for a clip that has no per-clip transform or effects.
 *
 * Internally constructs a synthetic RenderVideoClip (zoom=1, no crop, no
 * position, no effects) and runs it through the shared filtergraph builder,
 * so the resulting string is byte-identical to what preview-job-service
 * generates for the same case. Both preview and final render now go through
 * `shared/filtergraph.buildVideoClipFilterString`.
 *
 * The legacy `padColor` parameter is preserved for source compatibility but
 * is now ignored — the shared builder always relies on ffmpeg's default pad
 * color (black). Pass-through callers in this repo all used the default.
 */
export function buildAspectRatioFitFilter(
  outputWidth: number,
  outputHeight: number,
  // Deprecated — kept only so older call sites continue to type-check.
  // The shared filter builder uses ffmpeg's default pad color (black).
  _padColor: string = "black",
): string {
  void _padColor;
  return buildVideoClipFilterString(
    makeNoTransformClip(),
    { width: outputWidth, height: outputHeight },
  );
}

/**
 * Build the per-clip filter string from a transform descriptor sourced from
 * timeline metadata. Used by the assembler so that final-render segments
 * apply the same zoom/crop/position/effects as preview.
 */
export function buildVideoFitFilterFromTransform(
  outputWidth: number,
  outputHeight: number,
  transform: ClipFilterTransform = {},
): string {
  const clip: RenderVideoClip = {
    clipId: "fit",
    assetId: "fit",
    sourcePath: "",
    timelineInFrame: 0,
    durationFrames: 0,
    sourceInSec: 0,
    sourceOutSec: 0,
    transform: {
      mode: "cover",
      anchor: "center",
      zoom: typeof transform.zoom === "number" && transform.zoom > 0
        ? transform.zoom
        : 1,
      ...(transform.crop ? { crop: transform.crop } : {}),
      ...(transform.position ? { position: transform.position } : {}),
    },
    effects: transform.effects ?? [],
  };
  return buildVideoClipFilterString(clip, {
    width: outputWidth,
    height: outputHeight,
  });
}

/** Subset of RenderVideoClip transform fields the assembler can pass through. */
export interface ClipFilterTransform {
  zoom?: number;
  crop?: { x: number; y: number; width: number; height: number };
  position?: { x: number; y: number };
  effects?: RenderVideoClip["effects"];
}

function makeNoTransformClip(): RenderVideoClip {
  return {
    clipId: "fit",
    assetId: "fit",
    sourcePath: "",
    timelineInFrame: 0,
    durationFrames: 0,
    sourceInSec: 0,
    sourceOutSec: 0,
    transform: { mode: "cover", zoom: 1, anchor: "center" },
    effects: [],
  };
}

/** Probe the video stream dimensions of a file. */
async function probeVideoDimensions(
  inputPath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const result = await execFilePromise("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      inputPath,
    ]);
    const [w, h] = result.stdout.trim().split(",").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
    return null;
  } catch {
    return null;
  }
}

async function fitVideoToTimeline(
  inputPath: string,
  outputPath: string,
  timelinePath: string,
): Promise<string> {
  const sequence = readTimelineSequenceConfig(timelinePath);

  // Parity: when the assembly is already at the sequence dimensions
  // (always true for the shared-filtergraph assembler), re-encoding here
  // would add a lossy generation the preview path does not have. Skip.
  const dims = await probeVideoDimensions(inputPath);
  if (dims && dims.width === sequence.width && dims.height === sequence.height) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  const videoFilter = buildAspectRatioFitFilter(sequence.width, sequence.height);
  await execFilePromise("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vf", videoFilter,
    "-an",
    // Same near-lossless intermediate profile as the preview path.
    ...x264Args(INTERMEDIATE_X264),
    "-pix_fmt", "yuv420p",
    outputPath,
  ]);

  return outputPath;
}

// ── Phase 1: Demux ─────────────────────────────────────────────────

/**
 * Demux assembly.mp4 into raw_video.mp4 (video only) and
 * raw_dialogue.wav (audio only, PCM s16le).
 */
export async function demux(
  assemblyPath: string,
  outputDir: string,
  includeAudio = true,
): Promise<{ rawVideoPath: string; rawDialoguePath?: string }> {
  const videoDir = path.join(outputDir, "video");
  const audioDir = path.join(outputDir, "audio");
  ensureDir(videoDir);
  ensureDir(audioDir);

  const rawVideoPath = path.join(videoDir, "raw_video.mp4");
  const rawDialoguePath = path.join(audioDir, "raw_dialogue.wav");

  // Extract video stream only (no audio)
  await execFilePromise("ffmpeg", [
    "-y",
    "-i", assemblyPath,
    "-an",
    "-c:v", "copy",
    rawVideoPath,
  ]);

  if (!includeAudio) return { rawVideoPath };
  // Extract audio stream only as PCM WAV
  await execFilePromise("ffmpeg", [
    "-y",
    "-i", assemblyPath,
    "-vn",
    "-acodec", "pcm_s16le",
    rawDialoguePath,
  ]);

  return { rawVideoPath, rawDialoguePath };
}

// ── Phase 2: Caption Burn ──────────────────────────────────────────

/**
 * Burn subtitles into video using ffmpeg's subtitles filter.
 * Used when delivery_mode is "burn_in" or "both".
 */
export async function burnCaptions(
  rawVideoPath: string,
  srtPath: string,
  outputPath: string,
  sequence?: { width: number; height: number; fps: number },
  stylingClass?: string,
  canonicalCues?: AssCaptionCue[],
): Promise<string> {
  ensureDir(path.dirname(outputPath));

  // Parity: the exact preview and the final burn share buildAssDocument, so
  // captions render identically. burn-in converts the SRT to a styled ASS
  // with an explicit PlayResX/Y header — SRT + force_style alone leaves
  // libass on its 384x288 default PlayRes, which scaled MarginV up and
  // floated a bottom lower-third into mid-frame. styling_class selects the
  // per-project preset (position/width/wrap); unknown classes fall back to
  // the default. When no sequence is given, fall back to plain SRT burn.
  let subtitlePath = srtPath;
  if (sequence) {
    const preset = resolveCaptionStylePreset(stylingClass);
    const cues = canonicalCues ?? parseSrtCues(fs.readFileSync(srtPath, "utf-8"));
    const assContent = buildAssDocument(cues, preset, sequence);
    subtitlePath = srtPath.replace(/\.srt$/i, "") + ".burn.ass";
    fs.writeFileSync(subtitlePath, assContent, "utf-8");
  }

  const escapedSubtitlePath = subtitlePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
  const escapedFontsDir = resolveBundledFontPaths().fontsDir
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");

  const vf = `subtitles=filename='${escapedSubtitlePath}':fontsdir='${escapedFontsDir}'`;

  await execFilePromise("ffmpeg", [
    "-y",
    "-i", rawVideoPath,
    "-vf", vf,
    ...x264Args(INTERMEDIATE_X264),
    "-pix_fmt", "yuv420p",
    outputPath,
  ]);

  return outputPath;
}

interface ApprovedCaptionForBurn {
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  reveal_timing?: {
    status?: string;
    role?: string;
  };
}

/**
 * Keep visual emphasis on the same canonical frame as speech. A protected
 * semantic reveal gets the stronger pop; ordinary questions get a lighter
 * prompt. Text is never shifted earlier to make room for the animation.
 */
export function buildApprovedCaptionAssCues(
  captions: ApprovedCaptionForBurn[],
  fps: number,
): AssCaptionCue[] {
  return captions.map((caption) => {
    const body = caption.text.includes("｜")
      ? caption.text.slice(caption.text.indexOf("｜") + 1).trim()
      : caption.text.trim();
    const isProtectedReveal = caption.reveal_timing?.status === "protected"
      && ["punchline", "surprise", "reaction", "payoff"].includes(
        caption.reveal_timing?.role ?? "",
      );
    return {
      startSec: caption.timeline_in_frame / fps,
      endSec: (caption.timeline_in_frame + caption.timeline_duration_frames) / fps,
      text: caption.text,
      ...(isProtectedReveal
        ? { semanticRole: "reveal" as const }
        : /[?？][」』）】]?$/u.test(body)
          ? { semanticRole: "question" as const }
          : {}),
    };
  });
}

// ── Phase 3: SRT / VTT Generation ─────────────────────────────────

/**
 * Convert frame-based timecodes to SRT timestamp format:
 *   HH:MM:SS,mmm
 */
function framesToSrtTimestamp(frame: number, fps: number): string {
  const totalMs = Math.round((frame / fps) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

/**
 * Convert frame-based timecodes to VTT timestamp format:
 *   HH:MM:SS.mmm
 */
function framesToVttTimestamp(frame: number, fps: number): string {
  const totalMs = Math.round((frame / fps) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "." +
    String(ms).padStart(3, "0")
  );
}

/**
 * Generate SRT subtitle content from caption data.
 */
export function generateSrt(
  captions: Array<{
    timeline_in_frame: number;
    timeline_duration_frames: number;
    text: string;
  }>,
  fps: number,
): string {
  const lines: string[] = [];

  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const startFrame = cap.timeline_in_frame;
    const endFrame = cap.timeline_in_frame + cap.timeline_duration_frames;

    lines.push(String(i + 1));
    lines.push(
      `${framesToSrtTimestamp(startFrame, fps)} --> ${framesToSrtTimestamp(endFrame, fps)}`,
    );
    lines.push(cap.text);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate WebVTT subtitle content from caption data.
 */
export function generateVtt(
  captions: Array<{
    timeline_in_frame: number;
    timeline_duration_frames: number;
    text: string;
  }>,
  fps: number,
): string {
  const lines: string[] = ["WEBVTT", ""];

  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const startFrame = cap.timeline_in_frame;
    const endFrame = cap.timeline_in_frame + cap.timeline_duration_frames;

    lines.push(
      `${framesToVttTimestamp(startFrame, fps)} --> ${framesToVttTimestamp(endFrame, fps)}`,
    );
    lines.push(cap.text);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Phase 4: Final Mux ────────────────────────────────────────────

/**
 * Mux video and audio into the final deliverable:
 *   video (copy) + audio (AAC 192k) -> final.mp4
 */
export function buildFinalMuxArgs(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  durationSec?: number,
  durationFrames?: number,
): string[] {
  const args = [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
  ];
  if (durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0) {
    args.push("-t", durationSec.toFixed(6));
  }
  if (
    durationFrames !== undefined &&
    Number.isFinite(durationFrames) &&
    durationFrames > 0
  ) {
    args.push("-frames:v", String(Math.round(durationFrames)));
  }
  args.push(
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", String(FINAL_AUDIO_SAMPLE_RATE_HZ),
  );
  if (durationSec === undefined && durationFrames === undefined) {
    args.push("-shortest");
  }
  args.push(outputPath);
  return args;
}

export async function finalMux(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  durationSec?: number,
  durationFrames?: number,
): Promise<string> {
  ensureDir(path.dirname(outputPath));

  await execFilePromise(
    "ffmpeg",
    buildFinalMuxArgs(videoPath, audioPath, outputPath, durationSec, durationFrames),
  );

  return outputPath;
}

export function buildAudioDurationNormalizationArgs(
  inputPath: string,
  outputPath: string,
  durationSec: number,
): string[] {
  const duration = durationSec.toFixed(6);
  return [
    "-y",
    "-i", inputPath,
    "-af", `apad=pad_dur=${duration},atrim=duration=${duration}`,
    "-ar", String(FINAL_AUDIO_SAMPLE_RATE_HZ),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

async function normalizeAudioDuration(
  inputPath: string,
  durationSec: number,
): Promise<void> {
  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}.duration-normalized.wav`,
  );
  await execFilePromise(
    "ffmpeg",
    buildAudioDurationNormalizationArgs(inputPath, outputPath, durationSec),
  );
  fs.renameSync(outputPath, inputPath);
}

// ── Full Pipeline Orchestration ────────────────────────────────────

/**
 * Run the full render pipeline:
 * 1. Create output subdirs (video/, audio/, captions/, logs/)
 * 2. Verify assembly path exists (Remotion stub throws)
 * 3. Demux assembly -> raw_video + raw_dialogue
 * 4. Generate SRT/VTT sidecars if caption policy requires
 * 5. Burn captions into video if caption policy requires
 * 6. Mix audio (dialogue + BGM)
 * 7. Final mux -> final.mp4
 */
export async function runRenderPipeline(
  opts: RenderPipelineOptions,
): Promise<RenderPipelineResult> {
  const { outputDir, captionPolicy, fps } = opts;
  let hasCanonicalDerivedMedia = false;
  let hasCanonicalStill = false;
  if (opts.timelinePath && fs.existsSync(opts.timelinePath)) {
    const timeline = JSON.parse(fs.readFileSync(opts.timelinePath, "utf8"));
    assertTimelineRenderSupported(timeline, {
      projectDir: opts.projectDir,
      timelinePath: opts.timelinePath,
      sourceLocators: opts.sourceMap,
    });
    const canonicalInputs = resolveCanonicalRenderInputs(timeline, {
      projectDir: opts.projectDir,
      timelinePath: opts.timelinePath,
      sourceOverrides: opts.sourceMap,
    });
    hasCanonicalStill = canonicalInputs.imageAssetIds.size > 0;
    hasCanonicalDerivedMedia = hasCanonicalStill || canonicalInputs.sequenceAssetIds.size > 0;
  }

  // Preserve legacy option/file validation precedence without invoking an
  // assembler. The still-image guard then runs before output side effects or
  // alternate-engine dispatch.
  let resolvedEngine: AssemblyEngine | null = null;
  if (opts.assemblyPath) {
    if (!fs.existsSync(opts.assemblyPath)) {
      throw new Error(`Assembly file not found: ${opts.assemblyPath}`);
    }
    if (hasCanonicalDerivedMedia) {
      const projectDir = opts.projectDir ?? path.dirname(path.dirname(path.resolve(opts.timelinePath)));
      const freshness = assessRenderArtifactFreshness(projectDir, opts.assemblyPath);
      if (freshness.status !== "fresh") {
        throw new Error(`${hasCanonicalStill ? "image" : "sequence"}_prebuilt_assembly_not_fresh:${freshness.reason ?? freshness.status}`);
      }
    }
  } else {
    resolvedEngine = resolveAssemblyEngine(opts.assemblyEngine);
    if (!resolvedEngine) {
      throw new Error(
        "No assemblyPath provided and no assembly engine selected. " +
          "Either pass opts.assemblyPath, set opts.assemblyEngine, or set " +
          "VOS_RENDER_ENGINE to 'remotion' or 'ffmpeg'.",
      );
    }
    if (!opts.timelinePath || !opts.sourceMap || !opts.assemblyOutputPath) {
      throw new Error(
        "Alternate assembly engine requires timelinePath, sourceMap, and assemblyOutputPath options.",
      );
    }
  }
  // 1. Create output subdirs
  const videoDir = path.join(outputDir, "video");
  const audioDir = path.join(outputDir, "audio");
  const captionsDir = path.join(outputDir, "captions");
  const logsDir = path.join(outputDir, "logs");
  ensureDir(videoDir);
  ensureDir(audioDir);
  ensureDir(captionsDir);
  ensureDir(logsDir);

  const logs: Record<string, string> = {};
  const sidecarPaths: string[] = [];

  // 2. Verify or produce assembly path
  let assemblyPath: string;
  if (opts.assemblyPath) {
    assemblyPath = opts.assemblyPath;
  } else {
    const produced = await produceAssembly({
      timelinePath: opts.timelinePath,
      sourceMap: opts.sourceMap!,
      outputPath: opts.assemblyOutputPath!,
      engine: resolvedEngine!,
      bundleCacheDir: opts.bundleCacheDir,
    });
    assemblyPath = produced.assemblyPath;
  }

  // Preserve the established assembly-input error order above. Route
  // inspection reads canonical artifacts and must not mask those diagnostics.
  const routeDecision = opts.renderRouteDecision ?? resolveProjectRenderRoute(
    opts.projectDir,
    opts.assemblyEngine ?? "auto",
  );
  if (opts.assemblyPath && routeDecision.remotion_overlay_count > 0) {
    throw new Error(
      `Prebuilt assemblyPath cannot prove that ${routeDecision.remotion_overlay_count} ` +
        "Remotion-owned overlay clip(s) were rendered. Use the auto/remotion assembly route.",
    );
  }

  const baseAssemblyPath = assemblyPath;
  let hyperframesReceiptPath: string | undefined;

  // 2.5. Composite only HyperFrames-owned content elements. Remotion filters
  // those clips out at its renderer boundary, so each overlay has one owner.
  try {
    const contentResult = await renderHyperFramesContentOverlay({
      timelinePath: opts.timelinePath,
      baseAssemblyPath: assemblyPath,
      outputDir,
    });
    if (contentResult) {
      assemblyPath = contentResult.compositePath;
      logs["hyperframes"] = contentResult.receiptPath;
      hyperframesReceiptPath = contentResult.receiptPath;
    }
  } catch (err) {
    const logPath = writeLog(
      logsDir,
      "hyperframes",
      `HyperFrames content render failed: ${String(err)}`,
    );
    logs["hyperframes"] = logPath;
    throw new Error(`HyperFrames content render failed: ${String(err)}`);
  }

  const renderRouteReceiptPath = writeRenderRouteReceipt(outputDir, routeDecision, {
    baseAssemblyPath,
    effectiveAssemblyPath: assemblyPath,
    hyperframesReceiptPath,
  });
  logs["render_route"] = renderRouteReceiptPath;

  // 3. Demux
  let rawVideoPath: string;
  const timelineForMix = JSON.parse(fs.readFileSync(opts.timelinePath, "utf-8"));
  const hasTimelineAudio = (timelineForMix.tracks?.audio ?? []).some((track: { clips?: unknown[] }) => (track.clips?.length ?? 0) > 0) ||
    typeof timelineForMix.audio_mix?.bgm_asset_id === "string";
  let rawDialoguePath: string | undefined;
  try {
    const demuxResult = await demux(assemblyPath, outputDir, hasTimelineAudio);
    rawVideoPath = demuxResult.rawVideoPath;
    rawDialoguePath = demuxResult.rawDialoguePath;
    logs["demux"] = writeLog(logsDir, "demux", "Demux completed successfully");
  } catch (err) {
    const logPath = writeLog(logsDir, "demux", `Demux failed: ${String(err)}`);
    logs["demux"] = logPath;
    throw new Error(`Demux failed: ${String(err)}`);
  }

  // 3.5. Fit the video stream to timeline output dimensions with scale+pad.
  try {
    const normalizedVideoPath = path.join(videoDir, "raw_video.normalized.mp4");
    await fitVideoToTimeline(rawVideoPath, normalizedVideoPath, opts.timelinePath);
    fs.renameSync(normalizedVideoPath, rawVideoPath);
    logs["video_fit"] = writeLog(
      logsDir,
      "video_fit",
      `Normalized raw video to timeline output using ${path.basename(opts.timelinePath)}`,
    );
  } catch (err) {
    const logPath = writeLog(
      logsDir,
      "video_fit",
      `Video fit failed: ${String(err)}`,
    );
    logs["video_fit"] = logPath;
    throw new Error(`Video fit failed: ${String(err)}`);
  }

  // 4. Generate sidecar captions (SRT/VTT) if applicable
  let approvedCaptions: Array<{
    timeline_in_frame: number;
    timeline_duration_frames: number;
    text: string;
    reveal_timing?: {
      status?: string;
      role?: string;
    };
  }> = [];

  if (
    captionPolicy.source !== "none" &&
    opts.captionApprovalPath &&
    fs.existsSync(opts.captionApprovalPath)
  ) {
    const approvalDoc = JSON.parse(
      fs.readFileSync(opts.captionApprovalPath, "utf-8"),
    );
    approvedCaptions = approvalDoc.speech_captions || [];
  }

  if (
    captionPolicy.source !== "none" &&
    approvedCaptions.length > 0 &&
    (captionPolicy.delivery_mode === "sidecar" ||
      captionPolicy.delivery_mode === "both")
  ) {
    const srtContent = generateSrt(approvedCaptions, fps);
    const srtPath = path.join(captionsDir, "speech.approved.srt");
    fs.writeFileSync(srtPath, srtContent, "utf-8");
    sidecarPaths.push(srtPath);

    const vttContent = generateVtt(approvedCaptions, fps);
    const vttPath = path.join(captionsDir, "speech.vtt");
    fs.writeFileSync(vttPath, vttContent, "utf-8");
    sidecarPaths.push(vttPath);

    logs["caption_sidecar"] = writeLog(
      logsDir,
      "caption_sidecar",
      `Generated SRT (${srtPath}) and VTT (${vttPath})`,
    );
  }

  // 5. Burn captions into video if applicable
  let currentVideoPath = rawVideoPath;
  if (
    captionPolicy.source !== "none" &&
    approvedCaptions.length > 0 &&
    (captionPolicy.delivery_mode === "burn_in" ||
      captionPolicy.delivery_mode === "both")
  ) {
    // Burn-in must always be regenerated from the canonical approval. Reusing
    // an existing SRT can silently burn stale text after a caption-only re-edit.
    const srtForBurn = path.join(captionsDir, "speech.approved.srt");
    const srtContent = generateSrt(approvedCaptions, fps);
    fs.writeFileSync(srtForBurn, srtContent, "utf-8");

    const captionedVideoPath = path.join(videoDir, "captioned_video.mp4");
    try {
      const seq = readTimelineSequenceConfig(opts.timelinePath);
      await burnCaptions(
        rawVideoPath,
        srtForBurn,
        captionedVideoPath,
        { width: seq.width, height: seq.height, fps },
        captionPolicy.styling_class,
        buildApprovedCaptionAssCues(approvedCaptions, fps),
      );
      currentVideoPath = captionedVideoPath;
      logs["caption_burn"] = writeLog(
        logsDir,
        "caption_burn",
        "Caption burn completed successfully",
      );
    } catch (err) {
      const logPath = writeLog(
        logsDir,
        "caption_burn",
        `Caption burn failed: ${String(err)}`,
      );
      logs["caption_burn"] = logPath;
      throw new Error(`Caption burn failed: ${String(err)}`);
    }
  }

  // 6. Audio mix (dialogue + optional BGM -> final_mix.wav). Both paths use
  // the same mastering contract and emit machine-readable evidence for QA.
  const finalMixPath = path.join(audioDir, "final_mix.wav");
  const audioMixReportPath = path.join(logsDir, "audio-mix-report.json");
  const embeddedBgmAssetIds = timelineEmbeddedMusicAssetIds(timelineForMix);

  if (!hasTimelineAudio) {
    const finalVideoPath = path.join(videoDir, "final.mp4");
    fs.copyFileSync(currentVideoPath, finalVideoPath);
    logs["audio_mix"] = writeLog(logsDir, "audio_mix", "not_applicable: timeline has no audio or BGM; no audio stream fabricated");
    logs["final_mux"] = writeLog(logsDir, "final_mux", "Video-only final copied without fabricated audio");
    return {
      assemblyPath,
      rawVideoPath,
      rawDialoguePath: "",
      finalMixPath: "",
      finalVideoPath,
      sidecarPaths,
      logs,
      audioMixReportPath: "",
      renderRouteReceiptPath,
    };
  }
  if (!rawDialoguePath) throw new Error("timeline_audio_expected_but_demux_missing");

  if (opts.musicCuesPath && fs.existsSync(opts.musicCuesPath)) {
    // With music cues: attempt to import and use the audio mixer
    try {
      const { mixAudio, extractSpeechIntervals } = await import("../audio/mixer.js");
      const requestedMusicCuesDoc = JSON.parse(
        fs.readFileSync(opts.musicCuesPath, "utf-8"),
      ) as MusicCuesDoc;
      const effectiveMix = applyMusicMixProfile(requestedMusicCuesDoc, routeDecision.genre);
      const musicCuesDoc = effectiveMix.doc;
      const musicEligibility = assessMusicAssetEligibility(opts.projectDir, requestedMusicCuesDoc);
      if (!musicEligibility.eligible) {
        throw new Error(musicEligibility.message ?? "BGM asset is not eligible for rendering");
      }
      const musicAssetPath = musicCuesDoc?.music_asset?.path;
      if (typeof musicAssetPath !== "string" || musicAssetPath.trim().length === 0) {
        throw new Error("music_cues.music_asset.path is required for BGM mixing");
      }
      const bgmPath = path.isAbsolute(musicAssetPath)
        ? musicAssetPath
        : path.resolve(opts.projectDir, musicAssetPath);
      if (!fs.existsSync(bgmPath)) {
        throw new Error(`BGM audio file not found: ${bgmPath}`);
      }
      const a1Clips = Array.isArray(timelineForMix?.tracks?.audio)
        ? (timelineForMix.tracks.audio.find(
            (track: { track_id?: unknown }) => track?.track_id === "A1",
          )?.clips ?? [])
        : [];
      const embeddedBgm = embeddedBgmAssetIds.includes(musicCuesDoc.music_asset.asset_id);
      const mixResult = embeddedBgm
        ? await mixAudio({
            rawDialoguePath,
            speechIntervals: extractSpeechIntervals(a1Clips, fps),
            outputPath: finalMixPath,
            fps,
          })
        : await mixAudio({
            rawDialoguePath,
            bgmPath,
            musicCues: musicCuesDoc,
            speechIntervals: extractSpeechIntervals(a1Clips, fps),
            outputPath: finalMixPath,
            fps,
          });
      if (embeddedBgm) {
        mixResult.report.has_bgm = true;
        mixResult.report.strategy = "timeline_embedded_bgm_mastering_v1";
        mixResult.report.bgm_ownership = {
          owner: "timeline_assembler",
          asset_ids: embeddedBgmAssetIds,
        };
      }
      fs.writeFileSync(
        audioMixReportPath,
        `${JSON.stringify(mixResult.report, null, 2)}\n`,
        "utf-8",
      );
      logs["audio_mix_report"] = audioMixReportPath;
      logs["audio_mix"] = writeLog(
        logsDir,
        "audio_mix",
        embeddedBgm
          ? `Timeline-embedded BGM retained without re-adding asset ${musicCuesDoc.music_asset.asset_id}`
          : `Audio mix with BGM completed successfully (profile=${effectiveMix.profile}, adjusted=${effectiveMix.adjusted})`,
      );
    } catch (err) {
      logs["audio_mix"] = writeLog(
        logsDir,
        "audio_mix",
        `Required BGM mix failed: ${String(err)}`,
      );
      throw new Error(`Required BGM mix failed: ${String(err)}`);
    }
  } else {
    try {
      const { mixAudio } = await import("../audio/mixer.js");
      const mixResult = await mixAudio({
        rawDialoguePath,
        speechIntervals: [],
        outputPath: finalMixPath,
        fps,
      });
      if (embeddedBgmAssetIds.length > 0) {
        mixResult.report.has_bgm = true;
        mixResult.report.strategy = "timeline_embedded_bgm_mastering_v1";
        mixResult.report.bgm_ownership = {
          owner: "timeline_assembler",
          asset_ids: embeddedBgmAssetIds,
        };
      }
      fs.writeFileSync(
        audioMixReportPath,
        `${JSON.stringify(mixResult.report, null, 2)}\n`,
        "utf-8",
      );
      logs["audio_mix_report"] = audioMixReportPath;
      logs["audio_mix"] = writeLog(
        logsDir,
        "audio_mix",
        embeddedBgmAssetIds.length > 0
          ? `Timeline-embedded BGM retained without re-adding assets ${embeddedBgmAssetIds.join(",")}`
          : "No music cues; raw dialogue mastered with shared loudnorm defaults",
      );
    } catch (err) {
      logs["audio_mix"] = writeLog(
        logsDir,
        "audio_mix",
        `Required dialogue mastering failed: ${String(err)}`,
      );
      throw new Error(`Required dialogue mastering failed: ${String(err)}`);
    }
  }

  const timelineAudioDurationSec = readTimelineDurationSeconds(opts.timelinePath);
  if (timelineAudioDurationSec !== undefined) {
    await normalizeAudioDuration(finalMixPath, timelineAudioDurationSec);
    logs["audio_duration"] = writeLog(
      logsDir,
      "audio_duration",
      `Final mix normalized to timeline duration ${timelineAudioDurationSec.toFixed(6)}s`,
    );
  }

  // 7. Final mux
  const finalVideoPath = path.join(videoDir, "final.mp4");
  try {
    const timelineDurationSec = readTimelineDurationSeconds(opts.timelinePath);
    const timelineDurationFrames = timelineDurationSec === undefined
      ? undefined
      : Math.round(timelineDurationSec * fps);
    await finalMux(
      currentVideoPath,
      finalMixPath,
      finalVideoPath,
      timelineDurationSec,
      timelineDurationFrames,
    );
    logs["final_mux"] = writeLog(
      logsDir,
      "final_mux",
      timelineDurationSec === undefined
        ? "Final mux completed successfully"
        : `Final mux completed successfully at timeline duration ${timelineDurationSec.toFixed(6)}s`,
    );
  } catch (err) {
    const logPath = writeLog(
      logsDir,
      "final_mux",
      `Final mux failed: ${String(err)}`,
    );
    logs["final_mux"] = logPath;
    throw new Error(`Final mux failed: ${String(err)}`);
  }

  return {
    assemblyPath,
    rawVideoPath,
    rawDialoguePath,
    finalMixPath,
    finalVideoPath,
    sidecarPaths,
    logs,
    audioMixReportPath,
    renderRouteReceiptPath,
  };
}
