import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AudioMix, ClipOutput, TimelineIR, TrackOutput } from "../compiler/types.js";
import { assertTimelineRenderSupported } from "./media-kind-guard.js";
import {
  materializeVerifiedStillSnapshots,
  resolveCanonicalRenderInputs,
  type VerifiedStillSnapshotSet,
} from "./canonical-render-input.js";
import { assertSourceInputsUnchanged, createSourceInputAttestation } from "./source-input-attestation.js";
import { loadSourceMap, type LoadedSourceMap } from "../media/source-map.js";
import {
  buildAspectRatioFitFilter,
  buildVideoFitFilterFromTransform,
  type ClipFilterTransform,
} from "./pipeline.js";
import {
  isSupportedEffectType,
  type RenderEffectSpec,
} from "../../editor/shared/render-spec.js";
import {
  dialogueCutFadeSec,
  TALKING_HEAD_PACING_SKILL_ID,
} from "../../editor/shared/dialogue-cut-fade.js";
import {
  buildAudioFinishApplyFilter,
  buildAudioFinishPass1Args,
  resolveAudioFinishPolicy,
} from "../audio/dialogue-finishing.js";
import { parseLoudnormOutput } from "../audio/mastering.js";
import { INTERMEDIATE_X264, x264Args } from "../../editor/shared/encode-profiles.js";
import {
  buildTransitionSpec,
  buildTransitionChainArgs,
  buildGapAwareTransitionChainInputs,
  computeTransitionAudioExtensions,
  type TransitionChainInput,
  type TransitionChainTimelineInput,
  type TransitionAudioExtension,
} from "../../editor/shared/filtergraph.js";
import type { RenderTransition } from "../../editor/shared/render-spec.js";
import { resolveBundledFontPaths } from "../fonts/bundled-font.js";
import { assertSafeAudioDelayFilterOrder } from "./audio-filter-safety.js";
import {
  canonicalLinearGainFilter,
  resolveAudioGain,
  resolveAudioGainWithFallback,
  type AudioGainRole,
} from "../../editor/shared/audio-gain.js";
import { assertNoLegacyClipCaptionsForPackage } from "./legacy-caption-guard.js";
import { assertMediaWriteReady } from "../system/media-write-doctor.js";

export interface AssemblerOptions {
  projectDir: string;
  timelinePath?: string;
  outputPath?: string;
  ffmpegBin?: string;
  sampleRate?: number;
  audioChannels?: 1 | 2;
  cleanupTemp?: boolean;
  workingDirRoot?: string;
  execFileImpl?: ExecFileLike;
  /** Test/host seam for the fail-closed toolchain and capacity gate. */
  assertMediaWriteReadyImpl?: typeof assertMediaWriteReady;
  /**
   * Explicit asset_id -> source file map. Takes precedence over the
   * project-derived resolution (preview manifest, source map, assets.json).
   * Lets the orchestrator pass the same sourceMap it gives Remotion.
   */
  sourceOverrides?: Record<string, string>;
  includeAudio?: boolean;
  /**
   * Legacy clip captions are only a preview compatibility surface. Final
   * engine-render packaging must pass "reject" and use approved ASS/libass.
   * Finishing previews may pass "omit" to render the clean picture layer.
   */
  legacyCaptionMode?: "preview_burn" | "omit" | "reject";
}

export interface AssemblyResult {
  outputPath: string;
  workingDir: string;
  timelineDurationFrames: number;
  videoSegmentCount: number;
  audioClipCount: number;
}

export interface VideoSegmentPlan {
  kind: "clip" | "gap";
  start_frame: number;
  end_frame: number;
  duration_sec: number;
  track_id?: string;
  clip_id?: string;
  asset_id?: string;
  source_in_sec?: number;
  source_out_sec?: number;
  still?: {
    hold_frames: number;
    fit_mode: "contain" | "cover";
    background: string;
  };
}

export interface AudioClipPlan {
  track_id: string;
  clip_id: string;
  asset_id: string;
  source_in_sec: number;
  source_out_sec: number;
  duration_sec: number;
  timeline_start_sec: number;
  delay_ms: number;
  role?: string;
  audio_policy?: ClipOutput["audio_policy"];
}

export interface DuckingAudioMixPlan {
  delay_ms: number;
  isBgm: boolean;
  a1_loudnorm?: boolean;
}

type TimelineAudioPolicyMode = "ducking" | "bgm_only" | "original_only";

interface PreviewManifestClip {
  clip_id?: string;
  asset_id?: string;
  local_source_path?: string;
  source_locator?: string;
  media_link_path?: string;
}

interface AssetsManifestEntry {
  asset_id?: string;
  filename?: string;
}

interface SourceResolverContext {
  projectDir: string;
  timelineDir: string;
  sourceMap: LoadedSourceMap;
  previewByClipId: Map<string, PreviewManifestClip>;
  previewByAssetId: Map<string, PreviewManifestClip[]>;
  assetsById: Map<string, AssetsManifestEntry>;
  sourceOverrides?: Record<string, string>;
  canonicalInputs: VerifiedStillSnapshotSet;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFileError = Error & { code?: string | number | null };

type ExecFileCallback = (
  err: ExecFileError | null,
  stdout?: string | Buffer,
  stderr?: string | Buffer,
) => void;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { maxBuffer?: number },
  callback: ExecFileCallback,
) => void;

export function readTimeline(timelinePath: string): TimelineIR {
  return JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineIR;
}

export function getTimelineFps(timeline: TimelineIR): number {
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid timeline fps: ${timeline.sequence.fps_num}/${timeline.sequence.fps_den}`);
  }
  return fps;
}

export function getTimelineFpsRational(timeline: TimelineIR): string {
  return `${timeline.sequence.fps_num}/${timeline.sequence.fps_den}`;
}

function ffmpegColor(background: string): string {
  if (background === "black" || background === "white") return background;
  if (background === "transparent") return "black@0";
  if (/^#[a-fA-F0-9]{6}$/.test(background)) return `0x${background.slice(1)}`;
  if (/^#[a-fA-F0-9]{8}$/.test(background)) return `0x${background.slice(1)}`;
  throw new Error(`still_image_background_invalid:${background}`);
}

export function buildStillVideoFilter(width: number, height: number, fitMode: "contain" | "cover", background: string): string {
  const scale = fitMode === "contain"
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`;
  const placement = fitMode === "contain"
    ? `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${ffmpegColor(background)}`
    : `crop=${width}:${height}`;
  return `${scale},format=rgba,${placement},format=yuv420p,setsar=1`;
}

export function buildStillVideoArgs(
  inputPath: string,
  outputPath: string,
  frameCount: number,
  width: number,
  height: number,
  fpsRational: string,
  fitMode: "contain" | "cover",
  background: string,
): string[] {
  return [
    "-y", "-loop", "1", "-framerate", fpsRational, "-i", inputPath,
    "-map", "0:v:0", "-vf", buildStillVideoFilter(width, height, fitMode, background),
    "-frames:v", String(frameCount), "-an", "-r", fpsRational,
    "-c:v", "libx264", "-preset", INTERMEDIATE_X264.preset, "-qp", "0",
    "-pix_fmt", "yuv420p", outputPath,
  ];
}

export function getTimelineDurationFrames(timeline: TimelineIR): number {
  let maxFrame = 0;
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      const clipEnd = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (clipEnd > maxFrame) {
        maxFrame = clipEnd;
      }
    }
  }
  return maxFrame;
}

export function formatFfmpegTimestamp(seconds: number): string {
  const normalized = Math.max(0, seconds);
  return Number(normalized.toFixed(6)).toString();
}

export function buildConcatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
}

/**
 * FATAL-1 (Phase 5 review R1): the per-clip filter graph must come from the
 * shared filtergraph builder so the final assembly applies the same
 * zoom/crop/position/effects that preview applies. The optional `transform`
 * argument carries the clip's metadata-derived transform; when omitted
 * (gap fills, callers without metadata) we fall back to the no-transform
 * fit which is itself produced by the shared builder.
 */
export function buildVideoTrimArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  width: number,
  height: number,
  fps: number,
  transform?: ClipFilterTransform,
  endingFade?: { color: "black" | "white"; durationSec: number },
  timelineDurationSec?: number,
  fpsRational: string = String(fps),
  timelineDurationFrames?: number,
): string[] {
  const fitFilter = transform
    ? buildVideoFitFilterFromTransform(width, height, transform)
    : buildAspectRatioFitFilter(width, height);
  const clipDurationSec = Math.max(0, endSec - startSec);
  const fadeDurationSec = endingFade
    ? Math.min(clipDurationSec, endingFade.durationSec)
    : 0;
  const composedFilter = fadeDurationSec > 0 && endingFade
    ? `${fitFilter},fade=t=out:st=${formatFfmpegTimestamp(clipDurationSec - fadeDurationSec)}:d=${formatFfmpegTimestamp(fadeDurationSec)}:color=${endingFade.color}`
    : fitFilter;
  // Frame-bounded trims count frames at the point where the filter runs.
  // Normalize source cadence first so timeline frames are never interpreted as
  // 29.97/30 fps source frames on a 24 fps sequence.
  const videoFilter = timelineDurationSec !== undefined
    ? `${composedFilter},fps=${fpsRational},tpad=stop_mode=clone:stop_duration=1,${timelineDurationFrames !== undefined
      ? `trim=end_frame=${timelineDurationFrames}`
      : `trim=duration=${formatFfmpegTimestamp(timelineDurationSec)}`},setpts=PTS-STARTPTS`
    : composedFilter;
  return [
    "-y",
    "-ss", formatFfmpegTimestamp(startSec),
    "-to", formatFfmpegTimestamp(endSec),
    "-i", inputPath,
    "-map", "0:v:0",
    "-vf", videoFilter,
    "-an",
    "-r", fpsRational,
    "-fps_mode", "cfr",
    ...(timelineDurationFrames !== undefined
      ? ["-frames:v", String(timelineDurationFrames)]
      : timelineDurationSec !== undefined
        ? ["-t", formatFfmpegTimestamp(timelineDurationSec)]
      : []),
    // Parity: segment encodes must use the same near-lossless profile as
    // the preview path so cross-path frames share encoder settings.
    ...x264Args(INTERMEDIATE_X264),
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

/**
 * Extract a ClipFilterTransform from a clip's metadata bag, mirroring the
 * keys that buildRenderSpec reads. Anything missing or malformed degrades
 * silently to "no transform" — preview does the same and emits a warning,
 * but the assembler runs in a context where surfacing warnings to the user
 * is the orchestrator's job.
 */
export function extractClipTransform(
  clip: { metadata?: Record<string, unknown> },
): ClipFilterTransform | undefined {
  const meta = clip.metadata;
  if (!meta || typeof meta !== "object") return undefined;

  const transform: ClipFilterTransform = {};
  let touched = false;

  const zoom = (meta as Record<string, unknown>).zoom;
  if (typeof zoom === "number" && zoom > 0 && zoom !== 1) {
    transform.zoom = zoom;
    touched = true;
  }

  const cropRaw = (meta as Record<string, unknown>).crop;
  if (cropRaw && typeof cropRaw === "object") {
    const c = cropRaw as Record<string, unknown>;
    if (
      typeof c.x === "number" &&
      typeof c.y === "number" &&
      typeof c.width === "number" &&
      typeof c.height === "number"
    ) {
      transform.crop = { x: c.x, y: c.y, width: c.width, height: c.height };
      touched = true;
    }
  }

  const posRaw = (meta as Record<string, unknown>).position;
  if (posRaw && typeof posRaw === "object") {
    const p = posRaw as Record<string, unknown>;
    if (typeof p.x === "number" && typeof p.y === "number") {
      transform.position = { x: p.x, y: p.y };
      touched = true;
    }
  }

  const renderMeta = (meta as Record<string, unknown>).render;
  if (renderMeta && typeof renderMeta === "object") {
    const effectsRaw = (renderMeta as Record<string, unknown>).effects;
    if (Array.isArray(effectsRaw)) {
      const effects: RenderEffectSpec[] = [];
      for (const raw of effectsRaw) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as { type?: unknown; params?: unknown };
        if (typeof r.type !== "string") continue;
        if (!isSupportedEffectType(r.type)) continue;
        if (r.type === "none") continue;
        const params: Record<string, number | string> = {};
        if (r.params && typeof r.params === "object") {
          for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
            if (typeof v === "number" || typeof v === "string") params[k] = v;
          }
        }
        effects.push({ type: r.type, params });
      }
      if (effects.length > 0) {
        transform.effects = effects;
        touched = true;
      }
    }
  }

  return touched ? transform : undefined;
}

export function extractEndingVideoFade(
  clip: ClipOutput,
  fps: number,
): { color: "black" | "white"; durationSec: number } | undefined {
  const ending = clip.metadata?.ending_treatment;
  if (!ending || typeof ending !== "object" || Array.isArray(ending)) return undefined;
  const record = ending as Record<string, unknown>;
  const color = record.video_fade_color;
  const frames = record.video_fade_out_frames;
  if (
    (color !== "black" && color !== "white") ||
    typeof frames !== "number" ||
    !Number.isFinite(frames) ||
    frames <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0
  ) {
    return undefined;
  }
  return { color, durationSec: frames / fps };
}

export function buildGapVideoArgs(
  outputPath: string,
  durationSec: number,
  width: number,
  height: number,
  fps: number,
  fpsRational: string = String(fps),
): string[] {
  return [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fpsRational}`,
    "-t", formatFfmpegTimestamp(durationSec),
    "-an",
    ...x264Args(INTERMEDIATE_X264),
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

export function buildVideoConcatArgs(
  concatListPath: string,
  outputPath: string,
  _fps: number,
): string[] {
  // Parity: segments are already encoded with identical codec parameters
  // (same size/fps/pix_fmt/profile), so concat must stream-copy. A second
  // lossy generation here is what degraded preview⇄final SSIM to ~0.92.
  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-an",
    "-c:v", "copy",
    outputPath,
  ];
}

export function collectTimelineCaptions(timeline: TimelineIR): NonNullable<ClipOutput["captions"]> {
  return timeline.tracks.video
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.captions ?? [])
    .sort((a, b) => a.in_frame - b.in_frame);
}

export function buildCaptionDrawtextFilter(
  captions: NonNullable<ClipOutput["captions"]>,
  fps: number,
  width: number,
  height: number,
  fontPath: string = resolveBundledFontPaths().fontPath,
): string {
  return captions
    .map((caption) => {
      const startSec = caption.in_frame / fps;
      const endSec = caption.out_frame / fps;
      const preset = caption.style === "simple-shadow"
        ? { fontSize: Math.round(height * 0.042), y: "h*0.82" }
        : { fontSize: Math.round(height * 0.046), y: "h*0.80" };
      return [
        "drawtext=",
        `text='${escapeDrawtext(caption.text)}'`,
        `:fontfile='${escapeDrawtext(fontPath)}'`,
        ":fontcolor=white",
        `:fontsize=${Math.max(28, preset.fontSize)}`,
        ":line_spacing=8",
        ":box=1",
        ":boxcolor=black@0.32",
        ":boxborderw=18",
        ":shadowcolor=black@0.8",
        `:shadowx=${Math.max(2, Math.round(width * 0.002))}`,
        `:shadowy=${Math.max(2, Math.round(width * 0.002))}`,
        ":x=(w-text_w)/2",
        `:y=${preset.y}`,
        `:enable='between(t,${formatFfmpegTimestamp(startSec)},${formatFfmpegTimestamp(endSec)})'`,
      ].join("");
    })
    .join(",");
}

export function buildCaptionOverlayArgs(
  inputPath: string,
  outputPath: string,
  captions: NonNullable<ClipOutput["captions"]>,
  fps: number,
  width: number,
  height: number,
  fontPath: string = resolveBundledFontPaths().fontPath,
  fpsRational: string = String(fps),
): string[] {
  return [
    "-y",
    "-i", inputPath,
    "-vf", buildCaptionDrawtextFilter(captions, fps, width, height, fontPath),
    "-an",
    "-r", fpsRational,
    "-fps_mode", "cfr",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

export interface AudioTransitionFades {
  fadeInSec?: number;
  fadeOutSec?: number;
  dialogueCutFadeSec?: number;
}

export function buildAudioTrimArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  sampleRate: number,
  audioChannels: 1 | 2,
  audioPolicy?: ClipOutput["audio_policy"],
  fades?: AudioTransitionFades,
  fps = 30,
  gainRole: AudioGainRole = "nat",
  fallbackPolicy?: AudioMix,
): string[] {
  const gain = resolveAudioGainWithFallback(audioPolicy, fallbackPolicy, gainRole).gainLinear;
  const gainFilter = canonicalLinearGainFilter(gain);
  const filters = gainFilter ? [gainFilter] : [];
  const fadeInSec = Math.max(
    fades?.fadeInSec ?? 0,
    fades?.dialogueCutFadeSec ?? 0,
    (audioPolicy?.nat_sound_fade_in_frames ?? audioPolicy?.fade_in_frames ?? 0) / fps,
  );
  const fadeOutSec = Math.max(
    fades?.fadeOutSec ?? 0,
    fades?.dialogueCutFadeSec ?? 0,
    (audioPolicy?.nat_sound_fade_out_frames ?? audioPolicy?.fade_out_frames ?? 0) / fps,
  );
  // Transition parity: linear afade in/out summed by amix reproduces the
  // preview path's acrossfade (both default to the "tri" curve). Dialogue cut
  // fades share the same afade pair and are max-merged per edge.
  if (fadeInSec > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(6)}`);
  }
  if (fadeOutSec > 0) {
    const fadeStart = Math.max(0, endSec - startSec - fadeOutSec);
    filters.push(`afade=t=out:st=${fadeStart.toFixed(6)}:d=${fadeOutSec.toFixed(6)}`);
  }
  return [
    "-y",
    "-ss", formatFfmpegTimestamp(startSec),
    "-to", formatFfmpegTimestamp(endSec),
    "-i", inputPath,
    "-vn",
    ...(filters.length > 0 ? ["-af", filters.join(",")] : []),
    "-ac", String(audioChannels),
    "-ar", String(sampleRate),
    "-c:a", "pcm_s16le",
    outputPath,
  ];
}

export function buildBgmAudioRenderArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
  sampleRate: number,
  audioChannels: 1 | 2,
  fps: number,
  audioPolicy?: ClipOutput["audio_policy"],
  fallbackPolicy?: AudioMix,
): string[] {
  const fadeInFrames = audioPolicy?.bgm_fade_in_frames ?? audioPolicy?.fade_in_frames ?? 0;
  const fadeOutFrames = audioPolicy?.bgm_fade_out_frames ?? audioPolicy?.fade_out_frames ?? Math.round(fps);
  const fadeInSec = Math.max(0, fadeInFrames / fps);
  const fadeOutSec = Math.max(0, Math.min(durationSec / 2, fadeOutFrames / fps));
  const filters: string[] = [];
  const resolvedGain = resolveAudioGainWithFallback(audioPolicy, fallbackPolicy, "bgm");
  const bgmGain = resolvedGain.sourceField === null
    ? resolveAudioGain({ gain_unit: "linear", bgm_gain: 0.25 }, "bgm").gainLinear
    : resolvedGain.gainLinear;
  const gainFilter = canonicalLinearGainFilter(bgmGain);
  if (gainFilter) filters.push(gainFilter);

  if (fadeInSec > 0) {
    filters.push(`afade=t=in:d=${fadeInSec.toFixed(4)}`);
  }
  if (fadeOutSec > 0) {
    const fadeStart = Math.max(0, durationSec - fadeOutSec);
    filters.push(`afade=t=out:st=${fadeStart.toFixed(4)}:d=${fadeOutSec.toFixed(4)}`);
  }

  return [
    "-y",
    "-stream_loop", "-1",
    "-ss", formatFfmpegTimestamp(startSec),
    "-i", inputPath,
    "-vn",
    "-t", formatFfmpegTimestamp(durationSec),
    ...(filters.length > 0 ? ["-af", filters.join(",")] : []),
    "-ac", String(audioChannels),
    "-ar", String(sampleRate),
    "-c:a", "pcm_s16le",
    outputPath,
  ];
}

export function buildAudioMixFilter(
  delaysMs: number[],
  audioChannels: 1 | 2,
): string {
  const labels: string[] = [];
  const steps: string[] = [];
  const delayExpr = (delayMs: number) =>
    audioChannels === 1 ? `${delayMs}` : `${delayMs}|${delayMs}`;

  for (let i = 0; i < delaysMs.length; i++) {
    const label = `a${i}`;
    labels.push(`[${label}]`);
    steps.push(`[${i + 1}:a]adelay=${delayExpr(delaysMs[i])}[${label}]`);
  }

  const inputs = [`[0:a]`, ...labels].join("");
  steps.push(
    `${inputs}amix=inputs=${delaysMs.length + 1}:duration=longest:dropout_transition=0:normalize=0[aout]`,
  );

  const filterGraph = steps.join(";");
  assertSafeAudioDelayFilterOrder(filterGraph);
  return filterGraph;
}

export function buildDuckingAudioMixFilter(
  plans: DuckingAudioMixPlan[],
  audioChannels: 1 | 2,
): string {
  const delayExpr = (delayMs: number) =>
    audioChannels === 1 ? `${delayMs}` : `${delayMs}|${delayMs}`;
  const steps: string[] = [];
  const originalLabels: string[] = [];
  const bgmLabels: string[] = [];

  for (let i = 0; i < plans.length; i++) {
    const delayed = `d${i}`;
    steps.push(`[${i + 1}:a]adelay=${delayExpr(plans[i].delay_ms)}[${delayed}]`);
    if (plans[i].isBgm) {
      bgmLabels.push(`[${delayed}]`);
    } else {
      originalLabels.push(`[${delayed}]`);
    }
  }

  if (originalLabels.length === 0 || bgmLabels.length === 0) {
    const labels = [`[0:a]`, ...originalLabels, ...bgmLabels].join("");
    steps.push(`${labels}amix=inputs=${plans.length + 1}:duration=longest:dropout_transition=0:normalize=0[aout]`);
    const filterGraph = steps.join(";");
    assertSafeAudioDelayFilterOrder(filterGraph);
    return filterGraph;
  }

  const mixGroup = (labels: string[], output: string) => {
    if (labels.length === 1) {
      steps.push(`${labels[0]}anull[${output}]`);
    } else {
      steps.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[${output}]`);
    }
  };

  mixGroup(originalLabels, "origRaw");
  mixGroup(bgmLabels, "bgm");
  const shouldLoudnormA1 = plans.some((plan) => !plan.isBgm && plan.a1_loudnorm !== false);
  if (shouldLoudnormA1) {
    steps.push("[origRaw]loudnorm=I=-16:LRA=11:TP=-1.5[origMix]");
  } else {
    steps.push("[origRaw]anull[origMix]");
  }
  steps.push("[origMix]asplit=2[orig][scraw]");
  steps.push("[scraw]lowpass=f=3000[sc]");
  steps.push("[bgm][sc]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400:makeup=1:detection=rms[ducked]");
  steps.push("[orig][ducked]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]");

  const filterGraph = steps.join(";");
  assertSafeAudioDelayFilterOrder(filterGraph);
  return filterGraph;
}

export function buildSilentAudioArgs(
  outputPath: string,
  totalDurationSec: number,
  sampleRate: number,
  audioChannels: 1 | 2,
): string[] {
  return [
    "-y",
    "-f", "lavfi",
    "-t", formatFfmpegTimestamp(totalDurationSec),
    "-i", `anullsrc=channel_layout=${audioChannels === 1 ? "mono" : "stereo"}:sample_rate=${sampleRate}`,
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath,
  ];
}

export function buildAudioMixArgs(
  inputPaths: string[],
  outputPath: string,
  totalDurationSec: number,
  sampleRate: number,
  audioChannels: 1 | 2,
  delaysMs: number[],
  duckingPlans?: DuckingAudioMixPlan[],
): string[] {
  return [
    "-y",
    "-f", "lavfi",
    "-t", formatFfmpegTimestamp(totalDurationSec),
    "-i", `anullsrc=channel_layout=${audioChannels === 1 ? "mono" : "stereo"}:sample_rate=${sampleRate}`,
    ...inputPaths.flatMap((inputPath) => ["-i", inputPath]),
    "-filter_complex", duckingPlans
      ? buildDuckingAudioMixFilter(duckingPlans, audioChannels)
      : buildAudioMixFilter(delaysMs, audioChannels),
    "-map", "[aout]",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", formatFfmpegTimestamp(totalDurationSec),
    outputPath,
  ];
}

export function buildFinalAssemblyMuxArgs(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  options: { audioFilter?: string | null; durationSec?: number } = {},
): string[] {
  const durationArgs = options.durationSec !== undefined
    ? ["-t", formatFfmpegTimestamp(options.durationSec), "-shortest"]
    : [];
  const audioFilterArgs = options.audioFilter === null
    ? []
    : ["-af", options.audioFilter ?? "loudnorm=I=-16:LRA=11:TP=-1.5"];
  return [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    ...audioFilterArgs,
    "-ar", "48000",
    "-c:a", "aac",
    "-b:a", "192k",
    ...durationArgs,
    outputPath,
  ];
}

export function buildVideoAssemblyPlan(timeline: TimelineIR, imageAssetIds: ReadonlySet<string> = new Set()): VideoSegmentPlan[] {
  const fps = getTimelineFps(timeline);
  const totalFrames = getTimelineDurationFrames(timeline);
  if (totalFrames <= 0) {
    return [];
  }

  const boundaries = new Set<number>([0, totalFrames]);
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      boundaries.add(clip.timeline_in_frame);
      boundaries.add(clip.timeline_in_frame + clip.timeline_duration_frames);
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const plans: VideoSegmentPlan[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const startFrame = points[i];
    const endFrame = points[i + 1];
    if (endFrame <= startFrame) continue;

    const active = findActiveVideoClip(timeline.tracks.video, startFrame, endFrame);
    const durationSec = (endFrame - startFrame) / fps;

    if (!active) {
      plans.push({
        kind: "gap",
        start_frame: startFrame,
        end_frame: endFrame,
        duration_sec: durationSec,
      });
      continue;
    }

    const sourceRange = getClipSourceRange(active.clip, startFrame, endFrame, fps);
    plans.push({
      kind: "clip",
      start_frame: startFrame,
      end_frame: endFrame,
      duration_sec: durationSec,
      track_id: active.track.track_id,
      clip_id: active.clip.clip_id,
      asset_id: active.clip.asset_id,
      source_in_sec: sourceRange.startSec,
      source_out_sec: sourceRange.endSec,
      ...(active.clip.media_kind === "image" || active.clip.still_image || imageAssetIds.has(active.clip.asset_id)
        ? { still: {
            hold_frames: endFrame - startFrame,
            fit_mode: active.clip.still_image?.fit_mode ?? "contain",
            background: active.clip.still_image?.background ?? "black",
          } }
        : {}),
    });
  }

  return plans;
}

// ── Transition windows (preview/final parity) ───────────────────────

export interface TransitionWindow {
  start_frame: number;
  end_frame: number;
  from_clip: ClipOutput;
  to_clip: ClipOutput;
  /** xfade transition name from the shared TransitionSpec (e.g. "fade"). */
  xfade_transition: string;
}

/**
 * Derive xfade-capable transition windows from timeline.transitions.
 *
 * The compiler lays transitioned clips out with overlapping
 * timeline_in_frame ranges; the exact preview blends that overlap via the
 * shared transition graph. The assembler previously hard-cut inside the
 * overlap, which broke cross-path SSIM. Transition types whose shared spec
 * is not an xfade (j_cut/l_cut/cut) keep the hard-cut behavior.
 */
export function collectTransitionWindows(timeline: TimelineIR): TransitionWindow[] {
  const transitions = timeline.transitions ?? [];
  if (transitions.length === 0) return [];

  const fps = getTimelineFps(timeline);
  const clipsById = new Map<string, ClipOutput>();
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      clipsById.set(clip.clip_id, clip);
    }
  }

  const windows: TransitionWindow[] = [];
  for (const t of transitions) {
    const fromClip = clipsById.get(t.from_clip_id);
    const toClip = clipsById.get(t.to_clip_id);
    if (!fromClip || !toClip) continue;

    const overlapStart = toClip.timeline_in_frame;
    const overlapEnd = fromClip.timeline_in_frame + fromClip.timeline_duration_frames;
    if (overlapEnd <= overlapStart) continue;

    const renderTransition: RenderTransition = {
      fromClipId: t.from_clip_id,
      toClipId: t.to_clip_id,
      type: t.transition_type as RenderTransition["type"],
      durationFrames: t.transition_frames ?? overlapEnd - overlapStart,
    };
    const spec = buildTransitionSpec(renderTransition, fps);
    if (spec.video.method !== "xfade") continue;

    windows.push({
      start_frame: overlapStart,
      end_frame: overlapEnd,
      from_clip: fromClip,
      to_clip: toClip,
      xfade_transition: spec.video.xfadeTransition ?? "fade",
    });
  }
  return windows;
}

/**
 * Derive afade in/out durations for an audio clip whose boundaries fall on
 * a transition window (canonical compile mirrors A1 to V1, so timing-based
 * matching is sufficient — audio clip ids differ from the video clip ids
 * the transitions reference).
 */
export function computeAudioFades(
  plan: { timeline_start_sec: number; duration_sec: number },
  windows: TransitionWindow[],
  fps: number,
): AudioTransitionFades | undefined {
  const epsilon = 1e-3;
  const clipStart = plan.timeline_start_sec;
  const clipEnd = plan.timeline_start_sec + plan.duration_sec;
  let fadeInSec: number | undefined;
  let fadeOutSec: number | undefined;
  for (const w of windows) {
    const wStart = w.start_frame / fps;
    const wEnd = w.end_frame / fps;
    const wDur = wEnd - wStart;
    if (Math.abs(clipStart - wStart) < epsilon) fadeInSec = wDur;
    if (Math.abs(clipEnd - wEnd) < epsilon) fadeOutSec = wDur;
  }
  if (!fadeInSec && !fadeOutSec) return undefined;
  return { fadeInSec, fadeOutSec };
}

function collectTransitionAudioExtensionsByVideoClip(
  timeline: TimelineIR,
): Map<string, TransitionAudioExtension> {
  const fps = getTimelineFps(timeline);
  const orderedClips = timeline.tracks.video
    .flatMap((track) => track.clips)
    .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
  const idToIndex = new Map(orderedClips.map((clip, index) => [clip.clip_id, index]));

  const transitions = (timeline.transitions ?? []).flatMap((t) => {
    const fromIndex = idToIndex.get(t.from_clip_id);
    const toIndex = idToIndex.get(t.to_clip_id);
    if (fromIndex === undefined || toIndex === undefined) return [];
    const fromClip = orderedClips[fromIndex];
    const toClip = orderedClips[toIndex];
    const overlapFrames =
      fromClip.timeline_in_frame + fromClip.timeline_duration_frames -
      toClip.timeline_in_frame;
    const spec = buildTransitionSpec(
      {
        fromClipId: t.from_clip_id,
        toClipId: t.to_clip_id,
        type: t.transition_type as RenderTransition["type"],
        durationFrames: t.transition_frames ?? Math.max(0, overlapFrames),
      },
      fps,
    );
    return [{ spec, fromIndex, toIndex }];
  });

  const byIndex = computeTransitionAudioExtensions(
    orderedClips.map((clip) => ({
      sourceInSec: clip.src_in_us / 1_000_000,
      durationSec: (clip.src_out_us - clip.src_in_us) / 1_000_000,
    })),
    transitions,
  );

  const byClipId = new Map<string, TransitionAudioExtension>();
  for (const [index, extension] of byIndex) {
    const clip = orderedClips[index];
    if (clip) byClipId.set(clip.clip_id, extension);
  }
  return byClipId;
}

function findMirroredVideoClipForAudioPlan(
  timeline: TimelineIR,
  plan: AudioClipPlan,
  fps: number,
): ClipOutput | undefined {
  const epsilon = 1e-3;
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      if (clip.clip_id === plan.clip_id) return clip;
      const clipStartSec = clip.timeline_in_frame / fps;
      const clipDurationSec = clip.timeline_duration_frames / fps;
      if (
        Math.abs(clipStartSec - plan.timeline_start_sec) < epsilon &&
        Math.abs(clipDurationSec - plan.duration_sec) < (1 / fps + epsilon)
      ) {
        return clip;
      }
    }
  }
  return undefined;
}

function applyTransitionAudioExtensionToPlan(
  plan: AudioClipPlan,
  extension: TransitionAudioExtension | undefined,
): AudioClipPlan {
  if (!extension) return plan;
  const timelineStartSec = Math.max(
    0,
    plan.timeline_start_sec + extension.timelineStartShiftSec,
  );
  return {
    ...plan,
    source_in_sec: extension.audioSourceInSec,
    source_out_sec: extension.audioSourceInSec + extension.audioDurationSec,
    duration_sec: extension.audioDurationSec,
    timeline_start_sec: timelineStartSec,
    delay_ms: Math.round(timelineStartSec * 1000),
  };
}

/** ffmpeg args blending two same-length segments with xfade. */
export function buildXfadeArgs(
  inputAPath: string,
  inputBPath: string,
  outputPath: string,
  durationSec: number,
  transition: string,
): string[] {
  return [
    "-y",
    "-i", inputAPath,
    "-i", inputBPath,
    "-filter_complex",
    `[0:v][1:v]xfade=transition=${transition}:duration=${durationSec.toFixed(6)}:offset=0[v]`,
    "-map", "[v]",
    "-an",
    ...x264Args(INTERMEDIATE_X264),
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

export function buildAudioAssemblyPlan(timeline: TimelineIR): AudioClipPlan[] {
  const fps = getTimelineFps(timeline);
  const plans: AudioClipPlan[] = [];

  for (const track of timeline.tracks.audio) {
    for (const clip of track.clips) {
      plans.push({
        track_id: track.track_id,
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        source_in_sec: clip.src_in_us / 1_000_000,
        source_out_sec: clip.src_out_us / 1_000_000,
        duration_sec: clip.timeline_duration_frames / fps,
        timeline_start_sec: clip.timeline_in_frame / fps,
        delay_ms: Math.round((clip.timeline_in_frame / fps) * 1000),
        role: clip.role,
        audio_policy: clip.audio_policy,
      });
    }
  }

  return plans;
}

export function hasPinnedMusicCueA2(timeline: TimelineIR): boolean {
  if (timeline.provenance?.audio_policy?.mode === "original_only") return false;
  return timeline.tracks.audio
    .filter((track) => track.track_id === "A2")
    .flatMap((track) => track.clips)
    .some((clip) => {
      const metadata = clip.metadata as Record<string, unknown> | undefined;
      const cue = metadata?.music_cue;
      const asset = metadata?.music_asset;
      return Boolean(
        cue && typeof cue === "object" && !Array.isArray(cue)
        && typeof (cue as Record<string, unknown>).cue_id === "string"
        && asset && typeof asset === "object" && !Array.isArray(asset)
        && typeof (asset as Record<string, unknown>).pack_manifest_hash === "string"
        && typeof (asset as Record<string, unknown>).full_mix_content_hash === "string",
      );
    });
}

export function hasPinnedSfxCueA3(timeline: TimelineIR): boolean {
  if (timeline.provenance?.audio_policy?.mode === "original_only") return false;
  return timeline.tracks.audio
    .filter((track) => track.track_id === "A3")
    .flatMap((track) => track.clips)
    .some((clip) => {
      const metadata = clip.metadata as Record<string, unknown> | undefined;
      const cue = metadata?.sfx_cue;
      const asset = metadata?.sfx_asset;
      return Boolean(
        cue && typeof cue === "object" && !Array.isArray(cue)
        && typeof (cue as Record<string, unknown>).cue_id === "string"
        && asset && typeof asset === "object" && !Array.isArray(asset)
        && typeof (asset as Record<string, unknown>).library_manifest_hash === "string"
        && typeof (asset as Record<string, unknown>).asset_content_hash === "string",
      );
    });
}

export async function assembleTimelineToMp4(
  opts: AssemblerOptions,
): Promise<AssemblyResult> {
  const projectDir = path.resolve(opts.projectDir);
  const timelinePath = opts.timelinePath
    ? path.resolve(opts.timelinePath)
    : path.join(projectDir, "05_timeline", "timeline.json");
  const outputPath = opts.outputPath
    ? path.resolve(opts.outputPath)
    : path.join(projectDir, "05_timeline", "assembly.mp4");
  const ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
  const sampleRate = opts.sampleRate ?? 48_000;
  const audioChannels = opts.audioChannels ?? 2;
  const cleanupTemp = opts.cleanupTemp ?? true;
  const execFileImpl: ExecFileLike = opts.execFileImpl ?? defaultExecFile;

  const timeline = readTimeline(timelinePath);
  if (
    opts.includeAudio !== false
    && (hasPinnedMusicCueA2(timeline) || hasPinnedSfxCueA3(timeline))
  ) {
    throw new Error(
      "pinned_a2_or_a3_requires_shared_audio_render_plan: "
      + "assemble with includeAudio=false, then execute the shared AudioRenderPlan",
    );
  }
  if (opts.legacyCaptionMode === "reject") {
    assertNoLegacyClipCaptionsForPackage(timeline);
  }
  assertTimelineRenderSupported(timeline, {
    projectDir,
    timelinePath,
    sourceLocators: opts.sourceOverrides,
  });
  const sourceInputsBefore = createSourceInputAttestation(projectDir, {
    timelinePath,
    sourceOverrides: opts.sourceOverrides,
    includeAudio: opts.includeAudio !== false,
  });
  const fps = getTimelineFps(timeline);
  const fpsRational = getTimelineFpsRational(timeline);
  const totalFrames = getTimelineDurationFrames(timeline);
  if (totalFrames <= 0) {
    throw new Error(`Timeline has no clips to assemble: ${timelinePath}`);
  }

  const width = timeline.sequence.width;
  const height = timeline.sequence.height;
  if (!width || !height) {
    throw new Error(`Timeline width/height missing: ${timelinePath}`);
  }

  const workingDirRoot = opts.workingDirRoot ?? os.tmpdir();
  const totalDurationSec = totalFrames / fps;
  const estimatedOutputBytes = Math.max(
    256 * 1024 * 1024,
    Math.ceil(totalDurationSec * 2 * 1024 * 1024),
  );
  (opts.assertMediaWriteReadyImpl ?? assertMediaWriteReady)({
    reservations: [
      {
        label: "assembly output",
        path: outputPath,
        requiredBytes: estimatedOutputBytes,
      },
      {
        label: "assembly scratch",
        path: workingDirRoot,
        requiredBytes: Math.max(512 * 1024 * 1024, estimatedOutputBytes * 2),
      },
    ],
    requireFfmpeg: opts.execFileImpl === undefined,
    requireFfprobe: false,
    requireCaptionFilters: opts.legacyCaptionMode === "preview_burn" &&
      opts.execFileImpl === undefined,
  });
  const workingDir = fs.mkdtempSync(path.join(workingDirRoot, "vos-assembler-"));
  const timelineDir = path.dirname(timelinePath);
  const resolver = createSourceResolver(projectDir, timelineDir, timeline, opts.sourceOverrides);
  try {
  const videoPlans = buildVideoAssemblyPlan(timeline, resolver.canonicalInputs.imageAssetIds);
  const audioPlans = opts.includeAudio === false ? [] : buildAudioAssemblyPlan(timeline);
  const transitionWindows = collectTransitionWindows(timeline);
  const audioPolicyMode = getTimelineAudioPolicyMode(timeline);
  const audioFinish = resolveAudioFinishPolicy(timeline.metadata?.audio_finish);
  const dialogueCutFadeEnabled = timelineHasAppliedSkill(
    timeline,
    TALKING_HEAD_PACING_SKILL_ID,
  );
    const renderedVideoSegments: string[] = [];

    // Single-generation transition chain (cross-path parity): render every
    // timeline with declared transitions through the same shared graph the
    // exact preview uses. Gap inputs become black lavfi segments inside that
    // graph instead of forcing a divergent windowed fallback.
    const orderedClips = timeline.tracks.video
      .flatMap((track) => track.clips)
      .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
    const idToIndex = new Map(orderedClips.map((c, idx) => [c.clip_id, idx]));

    const clipChainTransitions = (timeline.transitions ?? []).flatMap((t) => {
      const fromIndex = idToIndex.get(t.from_clip_id);
      const toIndex = idToIndex.get(t.to_clip_id);
      if (fromIndex === undefined || toIndex === undefined) return [];
      const fromClip = orderedClips[fromIndex];
      const toClip = orderedClips[toIndex];
      const overlapFrames =
        fromClip.timeline_in_frame + fromClip.timeline_duration_frames -
        toClip.timeline_in_frame;
      const spec = buildTransitionSpec(
        {
          fromClipId: t.from_clip_id,
          toClipId: t.to_clip_id,
          type: t.transition_type as RenderTransition["type"],
          durationFrames: t.transition_frames ?? Math.max(0, overlapFrames),
        },
        fps,
      );
      if (spec.video.method === "cut" && spec.audio.method === "cut") {
        return [];
      }
      return [{ spec, fromIndex, toIndex }];
    });

    const clipChainInputs: TransitionChainTimelineInput[] = orderedClips.map((clip) => {
      const canonical = resolver.canonicalInputs.byAssetId.get(clip.asset_id);
      const isStill = canonical?.relationship === "normalized_still_frame";
      const transform = isStill ? undefined : extractClipTransform(clip);
      return {
        kind: "source",
        clipId: clip.clip_id,
        timelineInFrame: clip.timeline_in_frame,
        durationFrames: clip.timeline_duration_frames,
        sourcePath: resolveClipSourcePath(resolver, clip),
        sourceInSec: isStill ? 0 : clip.src_in_us / 1_000_000,
        durationSec: clip.timeline_duration_frames / fps,
        ...(isStill ? { still: { fps: fpsRational, frameCount: clip.timeline_duration_frames } } : {}),
        videoFilter: isStill
          ? buildStillVideoFilter(width, height, clip.still_image?.fit_mode ?? "contain", clip.still_image?.background ?? "black")
          : transform
          ? buildVideoFitFilterFromTransform(width, height, transform)
          : buildAspectRatioFitFilter(width, height),
        hasAudio: false,
      };
    });
    const gapAwareChain = buildGapAwareTransitionChainInputs(
      clipChainInputs,
      { fps, fpsRational, width, height, totalFrames },
    );
    const chainTransitions = clipChainTransitions.flatMap((t) => {
      const fromIndex = gapAwareChain.clipIndexToChainIndex.get(t.fromIndex);
      const toIndex = gapAwareChain.clipIndexToChainIndex.get(t.toIndex);
      if (fromIndex === undefined || toIndex === undefined) return [];
      return [{ ...t, fromIndex, toIndex }];
    });
    const useWholeChain = chainTransitions.length > 0;

    for (let i = 0; !useWholeChain && i < videoPlans.length; i++) {
      const plan = videoPlans[i];
      const segmentPath = path.join(workingDir, `video-segment-${String(i + 1).padStart(4, "0")}.mp4`);
      if (plan.kind === "gap") {
        await runFfmpeg(execFileImpl, ffmpegBin, buildGapVideoArgs(
          segmentPath,
          plan.duration_sec,
          width,
          height,
          fps,
          fpsRational,
        ));
      } else {
        const window = transitionWindows.find(
          (w) => w.start_frame === plan.start_frame && w.end_frame === plan.end_frame,
        );
        if (window) {
          // Transition overlap: blend both clips with the shared xfade spec
          // so the window matches the exact preview frame-for-frame.
          const durationSec = (window.end_frame - window.start_frame) / fps;
          const halfPaths: string[] = [];
          for (const [suffix, clip] of [
            ["a", window.from_clip],
            ["b", window.to_clip],
          ] as const) {
            const half = path.join(
              workingDir,
              `video-segment-${String(i + 1).padStart(4, "0")}-xfade-${suffix}.mp4`,
            );
            const range = getClipSourceRange(clip, plan.start_frame, plan.end_frame, fps);
            await runFfmpeg(execFileImpl, ffmpegBin, buildVideoTrimArgs(
              resolveClipSourcePath(resolver, clip),
              half,
              range.startSec,
              range.endSec,
              width,
              height,
              fps,
              extractClipTransform(clip),
              extractEndingVideoFade(clip, fps),
              durationSec,
              fpsRational,
              window.end_frame - window.start_frame,
            ));
            halfPaths.push(half);
          }
          await runFfmpeg(execFileImpl, ffmpegBin, buildXfadeArgs(
            halfPaths[0],
            halfPaths[1],
            segmentPath,
            durationSec,
            window.xfade_transition,
          ));
        } else {
          const clip = findClipById(timeline.tracks.video, plan.clip_id!);
          const sourcePath = resolveClipSourcePath(resolver, clip);
          if (plan.still) {
            await runFfmpeg(execFileImpl, ffmpegBin, buildStillVideoArgs(
              sourcePath, segmentPath, plan.still.hold_frames, width, height, fpsRational,
              plan.still.fit_mode, plan.still.background,
            ));
            renderedVideoSegments.push(segmentPath);
            continue;
          }
          // FATAL-1: derive per-clip transform from metadata so the final
          // segment goes through the same shared filtergraph as preview.
          const transform = extractClipTransform(clip);
          await runFfmpeg(execFileImpl, ffmpegBin, buildVideoTrimArgs(
            sourcePath,
            segmentPath,
            plan.source_in_sec!,
            plan.source_out_sec!,
            width,
            height,
            fps,
            transform,
            extractEndingVideoFade(clip, fps),
            plan.duration_sec,
            fpsRational,
            plan.end_frame - plan.start_frame,
          ));
        }
      }
      renderedVideoSegments.push(segmentPath);
    }

    const videoOnlyPath = path.join(workingDir, "assembly.video.mp4");
    if (useWholeChain) {
      await runFfmpeg(execFileImpl, ffmpegBin, buildTransitionChainArgs({
        inputs: gapAwareChain.inputs,
        clipDurationsSec: gapAwareChain.clipDurationsSec,
        transitions: chainTransitions,
        includeAudio: false,
        videoEncodeArgs: x264Args(INTERMEDIATE_X264),
        outputFps: fpsRational,
        outputPath: videoOnlyPath,
      }));
    } else {
      const concatListPath = path.join(workingDir, "video.concat.txt");
      fs.writeFileSync(concatListPath, buildConcatListContent(renderedVideoSegments), "utf-8");
      await runFfmpeg(execFileImpl, ffmpegBin, buildVideoConcatArgs(concatListPath, videoOnlyPath, fps));
    }
    const captions = opts.legacyCaptionMode === "reject" || opts.legacyCaptionMode === "omit"
      ? []
      : collectTimelineCaptions(timeline);
    const captionedVideoPath = captions.length > 0
      ? path.join(workingDir, "assembly.video.captioned.mp4")
      : videoOnlyPath;
    if (captions.length > 0) {
      await runFfmpeg(execFileImpl, ffmpegBin, buildCaptionOverlayArgs(
        videoOnlyPath,
        captionedVideoPath,
        captions,
        fps,
        width,
        height,
        undefined,
        fpsRational,
      ));
    }

    const canonicalStillWithoutAudio = audioPlans.length === 0 && orderedClips.some(
      (clip) => resolver.canonicalInputs.imageAssetIds.has(clip.asset_id),
    );
    if (opts.includeAudio === false || canonicalStillWithoutAudio) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(captionedVideoPath, outputPath);
      try {
        const sourceInputsAfter = createSourceInputAttestation(projectDir, {
          timelinePath,
          sourceOverrides: opts.sourceOverrides,
          includeAudio: opts.includeAudio !== false,
        });
        assertSourceInputsUnchanged(sourceInputsBefore, sourceInputsAfter);
      } catch (error) {
        fs.rmSync(outputPath, { force: true });
        throw error;
      }
      return {
        outputPath,
        workingDir,
        timelineDurationFrames: totalFrames,
        videoSegmentCount: videoPlans.length,
        audioClipCount: 0,
      };
    }

    const renderedAudioSegments: string[] = [];
    const audioDelaysMs: number[] = [];
    const duckingPlans: DuckingAudioMixPlan[] = [];
    const audioExtensionsByVideoClip =
      collectTransitionAudioExtensionsByVideoClip(timeline);
    const effectiveAudioPlans = audioPlans.filter((plan) => {
      const isBgm = isBgmPlan(plan);
      if (audioPolicyMode === "bgm_only") return isBgm;
      if (audioPolicyMode === "original_only") return !isBgm;
      return true;
    });
    for (let i = 0; i < effectiveAudioPlans.length; i++) {
      const basePlan = effectiveAudioPlans[i];
      const isBgm = isBgmPlan(basePlan);
      const mirroredVideoClip = isBgm
        ? undefined
        : findMirroredVideoClipForAudioPlan(timeline, basePlan, fps);
      const plan = applyTransitionAudioExtensionToPlan(
        basePlan,
        mirroredVideoClip
          ? audioExtensionsByVideoClip.get(mirroredVideoClip.clip_id)
          : undefined,
      );
      const clip = findClipById(timeline.tracks.audio, plan.clip_id);
      const sourcePath = resolveClipSourcePath(resolver, clip);
      const segmentPath = path.join(workingDir, `audio-segment-${String(i + 1).padStart(4, "0")}.wav`);
      const transitionFades = computeAudioFades(plan, transitionWindows, fps);
      const speechCutFadeSec = isBgm
        ? 0
        : dialogueCutFadeSec(plan.duration_sec, dialogueCutFadeEnabled);
      const audioArgs = isBgm
        ? buildBgmAudioRenderArgs(
          sourcePath,
          segmentPath,
          plan.source_in_sec,
          plan.duration_sec,
          sampleRate,
          audioChannels,
          fps,
          plan.audio_policy,
          timeline.audio_mix,
        )
        : buildAudioTrimArgs(
          sourcePath,
          segmentPath,
          plan.source_in_sec,
          plan.source_out_sec,
          sampleRate,
          audioChannels,
          plan.audio_policy,
          mergeAudioFades(transitionFades, speechCutFadeSec),
          fps,
          plan.role === "nat_sound" ? "nat_sound" : "nat",
          timeline.audio_mix,
        );
      await runFfmpeg(execFileImpl, ffmpegBin, audioArgs);
      renderedAudioSegments.push(segmentPath);
      audioDelaysMs.push(plan.delay_ms);
      duckingPlans.push({
        delay_ms: plan.delay_ms,
        isBgm,
        a1_loudnorm: isBgm
          ? undefined
          : audioFinish
            ? false
            : plan.audio_policy?.a1_loudnorm,
      });
    }

    const mixedAudioPath = path.join(workingDir, "assembly.audio.m4a");
    if (renderedAudioSegments.length === 0) {
      await runFfmpeg(execFileImpl, ffmpegBin, buildSilentAudioArgs(
        mixedAudioPath,
        totalDurationSec,
        sampleRate,
        audioChannels,
      ));
    } else {
      await runFfmpeg(execFileImpl, ffmpegBin, buildAudioMixArgs(
        renderedAudioSegments,
        mixedAudioPath,
        totalDurationSec,
        sampleRate,
        audioChannels,
        audioDelaysMs,
        audioPolicyMode === "ducking" ? duckingPlans : undefined,
      ));
    }

    let finalAudioFilter: string | undefined;
    if (audioFinish) {
      const measurementResult = await runFfmpeg(
        execFileImpl,
        ffmpegBin,
        buildAudioFinishPass1Args(mixedAudioPath, audioFinish),
      );
      const measurement = parseLoudnormOutput(measurementResult.stderr);
      finalAudioFilter = buildAudioFinishApplyFilter(audioFinish, measurement);
    }
    const preserveOriginalAudioLevel =
      audioPolicyMode === "original_only" &&
      effectiveAudioPlans.length > 0 &&
      effectiveAudioPlans.every((plan) =>
        isBgmPlan(plan) || plan.audio_policy?.a1_loudnorm === false
      );

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await runFfmpeg(execFileImpl, ffmpegBin, buildFinalAssemblyMuxArgs(
      captionedVideoPath,
      mixedAudioPath,
      outputPath,
      {
        audioFilter: finalAudioFilter ?? (preserveOriginalAudioLevel ? null : undefined),
        durationSec: totalDurationSec,
      },
    ));

    try {
      const sourceInputsAfter = createSourceInputAttestation(projectDir, {
        timelinePath,
        sourceOverrides: opts.sourceOverrides,
        includeAudio: true,
      });
      assertSourceInputsUnchanged(sourceInputsBefore, sourceInputsAfter);
    } catch (error) {
      fs.rmSync(outputPath, { force: true });
      throw error;
    }

    return {
      outputPath,
      workingDir,
      timelineDurationFrames: totalFrames,
      videoSegmentCount: videoPlans.length,
      audioClipCount: audioPlans.length,
    };
  } finally {
    resolver.canonicalInputs.dispose();
    if (cleanupTemp) {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  }
}

function getTimelineAudioPolicyMode(timeline: TimelineIR): TimelineAudioPolicyMode {
  const raw = timeline.provenance.audio_policy?.mode;
  if (raw === "bgm_only" || raw === "original_only" || raw === "ducking") {
    return raw;
  }
  return "ducking";
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function isBgmPlan(plan: AudioClipPlan): boolean {
  return plan.role === "bgm" || plan.role === "music" || plan.track_id === "A2";
}

function mergeAudioFades(
  transitionFades: AudioTransitionFades | undefined,
  dialogueFadeSec: number,
): AudioTransitionFades | undefined {
  if (dialogueFadeSec <= 0) return transitionFades;
  return {
    ...(transitionFades ?? {}),
    dialogueCutFadeSec: dialogueFadeSec,
  };
}

function timelineHasAppliedSkill(timeline: TimelineIR, skillId: string): boolean {
  const tracks = [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
  ];
  for (const track of tracks) {
    for (const clip of track.clips) {
      const editorial = (clip.metadata as Record<string, unknown> | undefined)?.editorial;
      if (!editorial || typeof editorial !== "object") continue;
      const appliedSkills = (editorial as { applied_skills?: unknown }).applied_skills;
      if (Array.isArray(appliedSkills) && appliedSkills.includes(skillId)) {
        return true;
      }
    }
  }
  return false;
}

function findActiveVideoClip(
  tracks: TrackOutput[],
  startFrame: number,
  endFrame: number,
): { track: TrackOutput; clip: ClipOutput } | undefined {
  for (const track of tracks) {
    for (const clip of track.clips) {
      const clipStart = clip.timeline_in_frame;
      const clipEnd = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (clipStart <= startFrame && endFrame <= clipEnd) {
        return { track, clip };
      }
    }
  }
  return undefined;
}

function getClipSourceRange(
  clip: ClipOutput,
  segmentStartFrame: number,
  segmentEndFrame: number,
  fps: number,
): { startSec: number; endSec: number } {
  const clipSourceDurationSec = (clip.src_out_us - clip.src_in_us) / 1_000_000;
  const clipTimelineDurationSec = clip.timeline_duration_frames / fps;
  const scale = clipTimelineDurationSec > 0
    ? clipSourceDurationSec / clipTimelineDurationSec
    : 1;
  const offsetStartSec = ((segmentStartFrame - clip.timeline_in_frame) / fps) * scale;
  const offsetEndSec = ((segmentEndFrame - clip.timeline_in_frame) / fps) * scale;

  return {
    startSec: clip.src_in_us / 1_000_000 + offsetStartSec,
    endSec: clip.src_in_us / 1_000_000 + offsetEndSec,
  };
}

function findClipById(
  tracks: TrackOutput[],
  clipId: string,
): ClipOutput {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.clip_id === clipId);
    if (clip) return clip;
  }
  throw new Error(`Clip not found in timeline: ${clipId}`);
}

function createSourceResolver(
  projectDir: string,
  timelineDir: string,
  timeline: TimelineIR,
  sourceOverrides?: Record<string, string>,
): SourceResolverContext {
  const previewPath = path.join(projectDir, "05_timeline", "preview-manifest.json");
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  const previewByClipId = new Map<string, PreviewManifestClip>();
  const previewByAssetId = new Map<string, PreviewManifestClip[]>();
  const assetsById = new Map<string, AssetsManifestEntry>();

  if (fs.existsSync(previewPath)) {
    const previewRaw = JSON.parse(fs.readFileSync(previewPath, "utf-8")) as {
      clips?: PreviewManifestClip[];
    };
    for (const clip of previewRaw.clips ?? []) {
      if (clip.clip_id) previewByClipId.set(clip.clip_id, clip);
      if (clip.asset_id) {
        const list = previewByAssetId.get(clip.asset_id) ?? [];
        list.push(clip);
        previewByAssetId.set(clip.asset_id, list);
      }
    }
  }

  if (fs.existsSync(assetsPath)) {
    const assetsRaw = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
      items?: AssetsManifestEntry[];
    };
    for (const asset of assetsRaw.items ?? []) {
      if (asset.asset_id) assetsById.set(asset.asset_id, asset);
    }
  }

  return {
    projectDir,
    timelineDir,
    sourceMap: loadSourceMap(projectDir),
    previewByClipId,
    previewByAssetId,
    assetsById,
    sourceOverrides,
    canonicalInputs: materializeVerifiedStillSnapshots(
      resolveCanonicalRenderInputs(timeline, {
        projectDir,
        timelinePath: path.join(timelineDir, "timeline.json"),
        sourceOverrides,
      }),
    ),
  };
}

function resolveClipSourcePath(
  ctx: SourceResolverContext,
  clip: ClipOutput,
): string {
  const canonical = ctx.canonicalInputs.byAssetId.get(clip.asset_id);
  if (canonical) return canonical.renderInputPath;
  const previewClip = ctx.previewByClipId.get(clip.clip_id);
  const previewAsset = ctx.previewByAssetId.get(clip.asset_id) ?? [];
  const sourceEntry = ctx.sourceMap.entryMap.get(clip.asset_id);
  const asset = ctx.assetsById.get(clip.asset_id);

  const candidateStrings = [
    ctx.sourceOverrides?.[clip.asset_id],
    ...readClipSourceHints(clip),
    previewClip?.local_source_path,
    previewClip?.source_locator,
    previewClip?.media_link_path,
    ...previewAsset.flatMap((item) => [
      item.local_source_path,
      item.source_locator,
      item.media_link_path,
    ]),
    sourceEntry?.local_source_path,
    sourceEntry?.source_locator,
    sourceEntry?.link_path,
    asset?.filename,
    asset?.filename ? path.join("00_sources", asset.filename) : undefined,
    asset?.filename ? path.join("02_media", asset.filename) : undefined,
  ].filter((value): value is string => !!value);

  for (const candidate of candidateStrings) {
    const resolved = resolveCandidatePath(ctx, candidate);
    if (resolved) return resolved;
  }

  if (asset?.filename) {
    const recursive = findProjectFileByBasename(ctx.projectDir, asset.filename);
    if (recursive) return recursive;
  }

  throw new Error(
    `Source file not found for asset ${clip.asset_id} (clip ${clip.clip_id}) under ${ctx.projectDir}`,
  );
}

function readClipSourceHints(clip: ClipOutput): string[] {
  const rawClip = clip as ClipOutput & {
    source_path?: string;
    source_locator?: string;
    local_source_path?: string;
  };
  const hints = [
    rawClip.source_path,
    rawClip.source_locator,
    rawClip.local_source_path,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  if (clip.metadata && typeof clip.metadata === "object") {
    const metadata = clip.metadata as Record<string, unknown>;
    for (const key of ["source_path", "source_locator", "local_source_path", "link_path"]) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) {
        hints.push(value);
      }
    }
  }

  return hints;
}

function resolveCandidatePath(
  ctx: SourceResolverContext,
  candidate: string,
): string | undefined {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return undefined;

  const attempts = new Set<string>();
  if (path.isAbsolute(trimmed)) {
    attempts.add(trimmed);
  } else {
    attempts.add(path.resolve(ctx.projectDir, trimmed));
    attempts.add(path.resolve(ctx.timelineDir, trimmed));
  }

  for (const attempt of attempts) {
    if (fs.existsSync(attempt) && fs.statSync(attempt).isFile()) {
      return attempt;
    }
  }

  return undefined;
}

function findProjectFileByBasename(
  projectDir: string,
  basename: string,
): string | undefined {
  const pending = [projectDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(nextPath);
        continue;
      }
      if (entry.isFile() && entry.name === basename) {
        return nextPath;
      }
    }
  }
  return undefined;
}

async function runFfmpeg(
  execFileImpl: ExecFileLike,
  ffmpegBin: string,
  args: string[],
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      ffmpegBin,
      args,
      { maxBuffer: 100 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") {
            reject(new Error("ffmpeg is not installed or not available on PATH"));
            return;
          }
          const detail = bufferToString(stderr).trim() || err.message;
          reject(new Error(detail));
          return;
        }

        resolve({
          stdout: bufferToString(stdout),
          stderr: bufferToString(stderr),
        });
      },
    );
  });
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

const defaultExecFile: ExecFileLike = (file, args, options, callback) => {
  (execFile as unknown as (
    file: string,
    args: string[],
    options: { maxBuffer?: number },
    callback: ExecFileCallback,
  ) => void)(
    file,
    [...args],
    options,
    callback,
  );
};
