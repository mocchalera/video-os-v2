// Rough-cut renderer CLI.
// Usage:
//   npx tsx scripts/render-rough-cut.ts --project <project-dir> [--output <path>] [--bgm <path>] [--reuse-video <path>] [--no-audio] [--defer-ending-fade]

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalLinearGainFilter,
  resolveAudioGainWithFallback,
  type AudioGainPolicyLike,
} from "../editor/shared/audio-gain.js";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  loadSourceMap,
  type MediaSourceMapDoc,
  type MediaSourceMapEntry,
} from "../runtime/media/source-map.js";
import {
  assembleTimelineToMp4,
  extractClipTransform,
} from "../runtime/render/assembler.js";
import { buildVideoFitFilterFromTransform } from "../runtime/render/pipeline.js";
import {
  assessRenderArtifactFreshness,
  createSourceInputAttestation,
  SourceInputAttestationError,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";
import { assertTimelineRenderSupported } from "../runtime/render/media-kind-guard.js";
import { resolveCanonicalRenderInputs } from "../runtime/render/canonical-render-input.js";
import { assertSafeAudioDelayFilterOrder } from "../runtime/render/audio-filter-safety.js";

const execFileAsync = promisify(execFile);

const USAGE =
  "Usage: npx tsx scripts/render-rough-cut.ts --project <project-dir> [--output <path>] [--bgm <path>] [--reuse-video <path>] [--no-audio] [--defer-ending-fade]";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4"]);
const BGM_EXTENSIONS = new Set([".mp3", ".wav"]);
const XFADE_DURATION_EPSILON_SEC = 0.001;
const DURATION_PARITY_THRESHOLD_SEC = 0.5;
const DURATION_PARITY_RELATIVE_THRESHOLD = 0.0005;
const AUDIO_VIDEO_SYNC_TOLERANCE_SEC = 0.1;

export interface RenderArgs {
  projectPath: string;
  timelinePath?: string;
  outputPath?: string;
  bgmPath?: string;
  reuseVideoPath?: string;
  noAudio: boolean;
  deferEndingFade?: boolean;
}

export interface TimelineClip {
  clip_id?: string;
  segment_id?: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame?: number;
  timeline_duration_frames: number;
  role?: string;
  audio_policy?: {
    gain_unit?: "linear" | "db";
    duck_music_db?: number;
    nat_gain?: number;
    nat_sound_gain?: number;
    bgm_gain?: number;
    fade_in_frames?: number;
    fade_out_frames?: number;
    nat_sound_fade_in_frames?: number;
    nat_sound_fade_out_frames?: number;
  };
  candidate_ref?: string;
  metadata?: Record<string, unknown>;
}

export interface RenderClip {
  clipId: string;
  segmentId?: string;
  assetId: string;
  sourcePath: string;
  startSec: number;
  durationSec: number;
  timelineInFrame: number;
  timelineDurationSec: number;
  sourceRangeDurationSec: number;
  timelineOutFrame: number;
  role?: string;
  audioPolicy?: TimelineClip["audio_policy"];
  audioMixPolicy?: AudioGainPolicyLike;
  candidateRef?: string;
  metadata?: Record<string, unknown>;
}

export type RenderAudioClip = RenderClip;

export interface BgmCandidate {
  path: string;
  durationSec: number;
}

export interface RenderTransition {
  fromClipId?: string;
  toClipId: string;
  durationSec: number;
}

export interface RenderGroup {
  clipPaths: string[];
  durationSec: number;
  transitionIn?: RenderTransition;
}

export interface XfadeSegment {
  path: string;
  durationSec: number;
  transitionIn?: RenderTransition;
}

export interface XfadeFilterGraph {
  filterComplex: string;
  outputLabel: string;
  durationSec: number;
  xfadeCount: number;
}

export interface RenderDurationAccounting {
  timeline_span_sec: number;
  timeline_content_sec: number;
  gap_sec: number;
  gap_count: number;
  crossfade_overlap_sec: number;
  source_clamp_sec: number;
  expected_rendered_sec: number;
  actual_rendered_sec?: number;
  parity_delta_sec?: number;
  parity_tolerance_sec?: number;
  parity_pass?: boolean;
}

interface VideoAssemblyTimingManifest {
  version: "1";
  timeline_hash: string;
  fps: number;
  assembly_duration_sec: number;
  clips: Array<{
    clip_id: string;
    rendered_duration_sec: number;
  }>;
}

export interface TimelineAudioVideoSyncIssue {
  videoClipId: string;
  audioClipId: string;
  assetId: string;
  timelineInFrame: number;
  videoStartSec: number;
  audioStartSec: number;
  deltaSec: number;
}

export interface RenderHardCutGroupOptions {
  fps: number;
  normalizeTimestamps: boolean;
}

export interface RenderSummary {
  outputPath: string;
  clipCount: number;
  audioClipCount: number;
  durationSec: number;
  fileSizeBytes: number;
  xfadeCount: number;
  durationAccounting: RenderDurationAccounting;
}

interface TimelineDoc {
  project_id?: string;
  sequence?: {
    fps_num?: number;
    fps_den?: number;
    width?: number;
    height?: number;
  };
  tracks?: {
    video?: Array<{
      clips?: unknown[];
    }>;
    audio?: Array<{
      clips?: unknown[];
    }>;
  };
  transitions?: unknown[];
  audio_mix?: AudioGainPolicyLike & { bgm_asset_id?: string };
}

interface AssetDoc {
  project_id?: string;
  items?: Array<{
    asset_id?: unknown;
    filename?: unknown;
    display_name?: unknown;
  }>;
}

export function parseArgs(argv: string[]): RenderArgs {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let outputPath: string | undefined;
  let bgmPath: string | undefined;
  let reuseVideoPath: string | undefined;
  let noAudio = false;
  let deferEndingFade = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--project" && i + 1 < args.length) {
      projectPath = args[++i];
    } else if (arg === "--output" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (arg === "--bgm" && i + 1 < args.length) {
      bgmPath = args[++i];
    } else if (arg === "--reuse-video" && i + 1 < args.length) {
      reuseVideoPath = args[++i];
    } else if (arg === "--no-audio") {
      noAudio = true;
    } else if (arg === "--defer-ending-fade") {
      deferEndingFade = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!projectPath) throw new Error("--project is required");
  return { projectPath, outputPath, bgmPath, reuseVideoPath, noAudio, deferEndingFade };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function videoAssemblyTimingPath(projectPath: string): string {
  return path.join(projectPath, "05_timeline", "video-assembly-timing.json");
}

export function writeVideoAssemblyTimingManifest(
  projectPath: string,
  timelinePath: string,
  fps: number,
  assemblyDurationSec: number,
  clips: RenderClip[],
  renderedDurationSecByClipId: Map<string, number>,
): void {
  const manifest: VideoAssemblyTimingManifest = {
    version: "1",
    timeline_hash: sha256FileHex(timelinePath),
    fps,
    assembly_duration_sec: assemblyDurationSec,
    clips: clips.map((clip) => {
      const renderedDurationSec = renderedDurationSecByClipId.get(clip.clipId);
      if (!renderedDurationSec || renderedDurationSec <= 0) {
        throw new Error(`Missing rendered duration for ${clip.clipId}`);
      }
      return {
        clip_id: clip.clipId,
        rendered_duration_sec: renderedDurationSec,
      };
    }),
  };
  atomicWriteJson(videoAssemblyTimingPath(projectPath), manifest);
}

function loadVideoAssemblyTimingManifest(
  projectPath: string,
  timelinePath: string,
  fps: number,
  assemblyDurationSec: number,
  clips: RenderClip[],
): Map<string, number> | undefined {
  const manifestPath = videoAssemblyTimingPath(projectPath);
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const manifest = readJson<VideoAssemblyTimingManifest>(manifestPath);
    if (
      manifest.version !== "1" ||
      manifest.timeline_hash !== sha256FileHex(timelinePath) ||
      Math.abs(manifest.fps - fps) > 0.000001 ||
      Math.abs(manifest.assembly_duration_sec - assemblyDurationSec) > DURATION_PARITY_THRESHOLD_SEC ||
      manifest.clips.length !== clips.length
    ) {
      return undefined;
    }

    const durations = new Map(
      manifest.clips.map((clip) => [clip.clip_id, clip.rendered_duration_sec]),
    );
    if (clips.some((clip) => !durations.has(clip.clipId))) return undefined;
    if ([...durations.values()].some((duration) => !Number.isFinite(duration) || duration <= 0)) {
      return undefined;
    }
    return durations;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: ignoring invalid video assembly timing manifest: ${message}`);
    return undefined;
  }
}

function toPosixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function fileStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function scanFiles(dir: string, extensions: Set<string>): string[] {
  if (!fs.existsSync(dir)) return [];

  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    let resolved: fs.Stats | fs.Dirent;
    try {
      resolved = entry.isSymbolicLink() ? fs.statSync(entryPath) : entry;
    } catch {
      continue;
    }
    if (resolved.isDirectory()) {
      found.push(...scanFiles(entryPath, extensions));
    } else if (resolved.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      found.push(entryPath);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

export function generateSourceMapFromAssets(projectPath: string): MediaSourceMapDoc {
  const absProject = path.resolve(projectPath);
  const assetsPath = path.join(absProject, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) {
    throw new Error(`source_map.json is missing and assets.json was not found: ${assetsPath}`);
  }

  const assets = readJson<AssetDoc>(assetsPath);
  const mediaDir = path.join(absProject, "02_media");
  const mediaByStem = new Map(
    scanFiles(mediaDir, VIDEO_EXTENSIONS).map((filePath) => [fileStem(filePath).toLowerCase(), filePath]),
  );

  const items: MediaSourceMapEntry[] = [];
  for (const asset of assets.items ?? []) {
    if (typeof asset.asset_id !== "string" || typeof asset.filename !== "string") continue;

    const sourcePath = mediaByStem.get(fileStem(asset.filename).toLowerCase());
    if (!sourcePath) continue;

    items.push({
      asset_id: asset.asset_id,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: toPosixRel(absProject, sourcePath),
      display_name: typeof asset.display_name === "string" ? asset.display_name : asset.filename,
      kind: "asset",
    });
  }

  const doc: MediaSourceMapDoc = {
    version: "1",
    project_id: assets.project_id ?? path.basename(absProject),
    media_dir: "02_media",
    generated_at: new Date().toISOString(),
    items,
  };

  atomicWriteJson(path.join(absProject, "02_media", "source_map.json"), doc);
  return doc;
}

export function ensureSourceMap(projectPath: string): Map<string, MediaSourceMapEntry> {
  const absProject = path.resolve(projectPath);
  const sourceMapPath = path.join(absProject, "02_media", "source_map.json");
  if (!fs.existsSync(sourceMapPath)) {
    generateSourceMapFromAssets(absProject);
  }
  return loadSourceMap(absProject).entryMap;
}

export function getTimelineFps(timeline: TimelineDoc): number {
  const fpsNum = timeline.sequence?.fps_num;
  const fpsDen = timeline.sequence?.fps_den;
  if (!fpsNum || !fpsDen || fpsDen === 0) {
    throw new Error("timeline.json sequence.fps_num / sequence.fps_den are required");
  }
  return fpsNum / fpsDen;
}

export function extractVideoClips(timeline: TimelineDoc): TimelineClip[] {
  return (timeline.tracks?.video ?? [])
    .flatMap((track, trackIndex) =>
      (track.clips ?? []).map((rawClip, clipIndex) => ({ rawClip, trackIndex, clipIndex })),
    )
    .filter(({ rawClip }) => {
      const clip = rawClip as Partial<TimelineClip>;
      return (
        typeof clip.asset_id === "string" &&
        typeof clip.src_in_us === "number" &&
        typeof clip.src_out_us === "number" &&
        typeof clip.timeline_duration_frames === "number" &&
        clip.timeline_duration_frames > 0
      );
    })
    .sort((a, b) => {
      const aClip = a.rawClip as Partial<TimelineClip>;
      const bClip = b.rawClip as Partial<TimelineClip>;
      return (
        (aClip.timeline_in_frame ?? 0) - (bClip.timeline_in_frame ?? 0) ||
        a.trackIndex - b.trackIndex ||
        a.clipIndex - b.clipIndex
      );
    })
    .map(({ rawClip }) => {
      const clip = rawClip as TimelineClip;
      return {
        clip_id: clip.clip_id,
        segment_id: clip.segment_id,
        asset_id: clip.asset_id,
        src_in_us: clip.src_in_us,
        src_out_us: clip.src_out_us,
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
        role: clip.role,
        candidate_ref: clip.candidate_ref,
        metadata: clip.metadata,
      };
    });
}

export function extractAudioClips(timeline: TimelineDoc): TimelineClip[] {
  return (timeline.tracks?.audio ?? [])
    .flatMap((track, trackIndex) =>
      (track.clips ?? []).map((rawClip, clipIndex) => ({ rawClip, trackIndex, clipIndex })),
    )
    .filter(({ rawClip }) => {
      const clip = rawClip as Partial<TimelineClip>;
      return (
        typeof clip.asset_id === "string" &&
        typeof clip.src_in_us === "number" &&
        typeof clip.src_out_us === "number" &&
        typeof clip.timeline_duration_frames === "number" &&
        clip.timeline_duration_frames > 0
      );
    })
    .sort((a, b) => {
      const aClip = a.rawClip as Partial<TimelineClip>;
      const bClip = b.rawClip as Partial<TimelineClip>;
      return (
        (aClip.timeline_in_frame ?? 0) - (bClip.timeline_in_frame ?? 0) ||
        a.trackIndex - b.trackIndex ||
        a.clipIndex - b.clipIndex
      );
    })
    .map(({ rawClip }) => {
      const clip = rawClip as TimelineClip;
      return {
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        src_in_us: clip.src_in_us,
        src_out_us: clip.src_out_us,
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
        role: clip.role,
        audio_policy: clip.audio_policy,
        candidate_ref: clip.candidate_ref,
      };
    });
}

function transitionDurationSec(raw: Record<string, unknown>, fps: number): number {
  const params = recordValue(raw.transition_params);
  const crossfadeSec = numberValue(params?.crossfade_sec);
  if (crossfadeSec !== undefined && crossfadeSec > 0) return crossfadeSec;

  const transitionFrames = numberValue(raw.transition_frames) ?? numberValue(raw.duration_frames);
  if (transitionFrames !== undefined && transitionFrames > 0) return transitionFrames / fps;

  return 0.5;
}

export function extractCrossfadeTransitions(
  timeline: TimelineDoc,
  fps: number,
): Map<string, RenderTransition> {
  const transitionsByToClipId = new Map<string, RenderTransition>();

  for (const item of timeline.transitions ?? []) {
    const raw = recordValue(item);
    if (!raw) continue;

    const transitionType = stringValue(raw.transition_type);
    if (transitionType !== "crossfade" && transitionType !== "match_cut_soft") continue;

    const toClipId = stringValue(raw.to_clip_id);
    if (!toClipId) continue;

    transitionsByToClipId.set(toClipId, {
      fromClipId: stringValue(raw.from_clip_id),
      toClipId,
      durationSec: transitionDurationSec(raw, fps),
    });
  }

  return transitionsByToClipId;
}

function transitionForBoundary(
  previousClip: RenderClip,
  nextClip: RenderClip,
  transitionsByToClipId: Map<string, RenderTransition>,
): RenderTransition | undefined {
  const transition = transitionsByToClipId.get(nextClip.clipId);
  if (!transition) return undefined;
  if (transition.fromClipId && transition.fromClipId !== previousClip.clipId) return undefined;
  return transition;
}

export function buildRenderGroups(
  clips: RenderClip[],
  clipPaths: string[],
  transitionsByToClipId: Map<string, RenderTransition>,
): RenderGroup[] {
  if (clips.length !== clipPaths.length) {
    throw new Error(`clip path count mismatch: ${clips.length} clips, ${clipPaths.length} paths`);
  }
  if (clips.length === 0) return [];

  const groups: RenderGroup[] = [{
    clipPaths: [clipPaths[0]],
    durationSec: clips[0].durationSec,
  }];

  for (let index = 1; index < clips.length; index += 1) {
    const transition = transitionForBoundary(clips[index - 1], clips[index], transitionsByToClipId);
    if (transition) {
      groups.push({
        clipPaths: [clipPaths[index]],
        durationSec: clips[index].durationSec,
        transitionIn: transition,
      });
      continue;
    }

    const current = groups[groups.length - 1];
    current.clipPaths.push(clipPaths[index]);
    current.durationSec += clips[index].durationSec;
  }

  return groups;
}

export function computeVideoRenderStartSecByClipId(
  clips: RenderClip[],
  transitionsByToClipId: Map<string, RenderTransition>,
  renderedDurationSecByClipId?: Map<string, number>,
): Map<string, number> {
  const starts = new Map<string, number>();
  if (clips.length === 0) return starts;

  let cursorSec = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const clipDurationSec = renderedDurationSecByClipId?.get(clip.clipId) ?? clip.durationSec;
    let startSec = cursorSec;

    if (index > 0) {
      const previousClip = clips[index - 1];
      const previousDurationSec = renderedDurationSecByClipId?.get(previousClip.clipId) ??
        previousClip.durationSec;
      const transition = transitionForBoundary(previousClip, clip, transitionsByToClipId);
      if (transition) {
        startSec = Math.max(
          0,
          cursorSec - effectiveXfadeDuration(
            transition.durationSec,
            previousDurationSec,
            clipDurationSec,
          ),
        );
      }
    }

    starts.set(clip.clipId, startSec);
    cursorSec = startSec + clipDurationSec;
  }

  return starts;
}

export function buildRenderClips(
  clips: TimelineClip[],
  sourceMap: Map<string, MediaSourceMapEntry>,
  fps: number,
  warn: (message: string) => void = console.warn,
  options: { allowEndingPostroll?: boolean; audioMixPolicy?: AudioGainPolicyLike } = {},
): RenderClip[] {
  const renderClips: RenderClip[] = [];

  for (const clip of clips) {
    const entry = sourceMap.get(clip.asset_id);
    const sourcePath = entry?.source_locator;
    if (!sourcePath) {
      warn(`Warning: skipping ${clip.clip_id ?? clip.asset_id}; missing source_map entry for ${clip.asset_id}`);
      continue;
    }
    if (!fs.existsSync(sourcePath)) {
      warn(`Warning: skipping ${clip.clip_id ?? clip.asset_id}; source file not found: ${sourcePath}`);
      continue;
    }

    const timelineDurationSec = clip.timeline_duration_frames / fps;
    const sourceRangeDurationSec = (clip.src_out_us - clip.src_in_us) / 1_000_000;
    const endingTreatment = recordValue(clip.metadata?.ending_treatment);
    const hasMovingEndingPostroll = options.allowEndingPostroll === true &&
      endingTreatment !== undefined &&
      timelineDurationSec > sourceRangeDurationSec;
    renderClips.push({
      clipId: clip.clip_id ?? `${clip.asset_id}_${renderClips.length + 1}`,
      ...(clip.segment_id ? { segmentId: clip.segment_id } : {}),
      assetId: clip.asset_id,
      sourcePath,
      startSec: clip.src_in_us / 1_000_000,
      durationSec: hasMovingEndingPostroll
        ? timelineDurationSec
        : Math.min(timelineDurationSec, sourceRangeDurationSec),
      timelineInFrame: clip.timeline_in_frame ?? 0,
      timelineDurationSec,
      sourceRangeDurationSec,
      timelineOutFrame: (clip.timeline_in_frame ?? 0) + clip.timeline_duration_frames,
      role: clip.role,
      audioPolicy: clip.audio_policy,
      audioMixPolicy: options.audioMixPolicy,
      ...(clip.candidate_ref ? { candidateRef: clip.candidate_ref } : {}),
      ...(clip.metadata ? { metadata: clip.metadata } : {}),
    });
  }

  return renderClips;
}

export const buildRenderAudioClips = buildRenderClips;

function concatEscape(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

export function writeConcatList(listPath: string, clipPaths: string[]): void {
  const body = clipPaths.map((clipPath) => `file '${concatEscape(path.resolve(clipPath))}'`).join("\n");
  fs.writeFileSync(listPath, `${body}\n`, "utf-8");
}

function ffmpegNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function ffmpegAudioDelay(valueMs: number): string {
  const delay = Math.max(0, Math.round(valueMs));
  return `${delay}|${delay}`;
}

function audioGainFilter(clip: RenderAudioClip): string | undefined {
  const role = clip.role === "bgm" || clip.role === "music"
    ? "bgm"
    : clip.role === "nat_sound"
      ? "nat_sound"
      : "nat";
  const gain = resolveAudioGainWithFallback(clip.audioPolicy, clip.audioMixPolicy, role).gainLinear;
  return canonicalLinearGainFilter(gain);
}

function audioFadeFilters(clip: RenderAudioClip, fps: number): string[] {
  const fadeInFrames = clip.audioPolicy?.nat_sound_fade_in_frames ??
    clip.audioPolicy?.fade_in_frames ?? 0;
  const fadeOutFrames = clip.audioPolicy?.nat_sound_fade_out_frames ??
    clip.audioPolicy?.fade_out_frames ?? 0;
  const filters: string[] = [];
  if (fadeInFrames > 0) {
    filters.push(`afade=t=in:st=0:d=${ffmpegNumber(Math.min(clip.durationSec, fadeInFrames / fps))}`);
  }
  if (fadeOutFrames > 0) {
    const durationSec = Math.min(clip.durationSec, fadeOutFrames / fps);
    filters.push(
      `afade=t=out:st=${ffmpegNumber(Math.max(0, clip.durationSec - durationSec))}:d=${ffmpegNumber(durationSec)}`,
    );
  }
  return filters;
}

function videoFadeFilter(clip: RenderClip, fps: number): string | undefined {
  const ending = recordValue(clip.metadata?.ending_treatment);
  const color = ending?.video_fade_color;
  const frames = numberValue(ending?.video_fade_out_frames) ?? 0;
  if ((color !== "black" && color !== "white") || frames <= 0) return undefined;
  const durationSec = Math.min(clip.durationSec, frames / fps);
  const startSec = Math.max(0, clip.durationSec - durationSec);
  return `fade=t=out:st=${ffmpegNumber(startSec)}:d=${ffmpegNumber(durationSec)}:color=${color}`;
}

export function buildClipVideoFilters(
  clip: RenderClip,
  fps: number,
  options: {
    applyEndingFade?: boolean;
    outputWidth?: number;
    outputHeight?: number;
  } = {},
): string {
  const fitFilter = buildVideoFitFilterFromTransform(
    options.outputWidth ?? 1920,
    options.outputHeight ?? 1080,
    extractClipTransform(clip) ?? {},
  );
  return [
    "setpts=PTS-STARTPTS",
    `fps=${fps}`,
    fitFilter,
    options.applyEndingFade === false ? undefined : videoFadeFilter(clip, fps),
  ].filter(Boolean).join(",");
}

function sameTimelinePlacement(a: RenderClip, b: RenderClip): boolean {
  return (
    a.assetId === b.assetId &&
    a.startSec === b.startSec &&
    a.durationSec === b.durationSec &&
    a.timelineInFrame === b.timelineInFrame
  );
}

function rangesOverlapFrames(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function isBgmAudioClip(clip: RenderAudioClip): boolean {
  return clip.role === "bgm";
}

export function findTimelineAudioVideoSyncIssues(
  videoClips: RenderClip[],
  audioClips: RenderAudioClip[],
  fps: number,
  toleranceSec = AUDIO_VIDEO_SYNC_TOLERANCE_SEC,
): TimelineAudioVideoSyncIssue[] {
  const toleranceFrames = Math.max(1, Math.ceil(toleranceSec * fps));
  const issues: TimelineAudioVideoSyncIssue[] = [];

  for (const audioClip of audioClips) {
    if (isBgmAudioClip(audioClip)) continue;

    for (const videoClip of videoClips) {
      if (videoClip.assetId !== audioClip.assetId) continue;
      if (videoClip.sourcePath !== audioClip.sourcePath) continue;
      if (
        videoClip.segmentId &&
        audioClip.segmentId &&
        videoClip.segmentId !== audioClip.segmentId
      ) {
        continue;
      }
      if (
        !rangesOverlapFrames(
          videoClip.timelineInFrame,
          videoClip.timelineOutFrame,
          audioClip.timelineInFrame,
          audioClip.timelineOutFrame,
        )
      ) {
        continue;
      }
      if (Math.abs(videoClip.timelineInFrame - audioClip.timelineInFrame) > toleranceFrames) {
        continue;
      }

      const deltaSec = audioClip.startSec - videoClip.startSec;
      const durationDeltaSec = Math.abs(audioClip.durationSec - videoClip.durationSec);
      const timelineStartDeltaSec =
        (audioClip.timelineInFrame - videoClip.timelineInFrame) / fps;
      const sourceEndDeltaSec =
        (videoClip.startSec + videoClip.sourceRangeDurationSec) -
        (audioClip.startSec + audioClip.sourceRangeDurationSec);
      const timelineEndDeltaSec =
        (videoClip.timelineOutFrame - audioClip.timelineOutFrame) / fps;
      const intentionalCutBreathing =
        Math.abs(deltaSec - timelineStartDeltaSec) <= toleranceSec &&
        Math.abs(sourceEndDeltaSec - timelineEndDeltaSec) <= toleranceSec;
      const intentionalMovingPostroll =
        recordValue(videoClip.metadata?.ending_treatment) !== undefined &&
        videoClip.durationSec >= audioClip.durationSec &&
        Math.abs(deltaSec) <= toleranceSec;
      if (intentionalCutBreathing || intentionalMovingPostroll) {
        continue;
      }
      if (Math.abs(deltaSec) <= toleranceSec && durationDeltaSec <= toleranceSec) {
        continue;
      }

      issues.push({
        videoClipId: videoClip.clipId,
        audioClipId: audioClip.clipId,
        assetId: videoClip.assetId,
        timelineInFrame: videoClip.timelineInFrame,
        videoStartSec: videoClip.startSec,
        audioStartSec: audioClip.startSec,
        deltaSec,
      });
    }
  }

  return issues;
}

export function assertTimelineAudioVideoSync(
  videoClips: RenderClip[],
  audioClips: RenderAudioClip[],
  fps: number,
): void {
  const issues = findTimelineAudioVideoSyncIssues(videoClips, audioClips, fps);
  if (issues.length === 0) return;

  const details = issues
    .slice(0, 5)
    .map((issue) =>
      `${issue.audioClipId} overlaps ${issue.videoClipId} on ${issue.assetId} at frame ${issue.timelineInFrame}: audio starts ${issue.audioStartSec.toFixed(3)}s, video starts ${issue.videoStartSec.toFixed(3)}s, delta ${issue.deltaSec.toFixed(3)}s`,
    )
    .join("; ");
  throw new Error(`Audio/video sync guard failed before render: ${details}`);
}

function findMirroredVideoClip(audioClip: RenderAudioClip, videoClips: RenderClip[]): RenderClip | undefined {
  return (
    videoClips.find((clip) => clip.clipId === audioClip.clipId) ??
    videoClips.find((clip) => sameTimelinePlacement(audioClip, clip))
  );
}

export function buildAudioDelaySecByClipId(
  audioClips: RenderAudioClip[],
  videoClips: RenderClip[],
  transitionsByToClipId: Map<string, RenderTransition>,
  renderDurationScale = 1,
  renderedDurationSecByVideoClipId?: Map<string, number>,
): Map<string, number> {
  if (!Number.isFinite(renderDurationScale) || renderDurationScale <= 0) {
    throw new Error(`Invalid audio render duration scale: ${renderDurationScale}`);
  }
  const videoStarts = computeVideoRenderStartSecByClipId(
    videoClips,
    transitionsByToClipId,
    renderedDurationSecByVideoClipId,
  );
  const audioDelays = new Map<string, number>();

  for (const audioClip of audioClips) {
    const mirroredVideoClip = findMirroredVideoClip(audioClip, videoClips);
    const delaySec = mirroredVideoClip ? videoStarts.get(mirroredVideoClip.clipId) : undefined;
    if (delaySec !== undefined) {
      audioDelays.set(audioClip.clipId, delaySec * renderDurationScale);
    }
  }

  return audioDelays;
}

export function buildTimelineAudioMixFilter(
  audioClips: RenderAudioClip[],
  totalDurationSec: number,
  fps: number,
  options: {
    includeBgm?: boolean;
    bgmGain?: number;
    audioDelaySecByClipId?: Map<string, number>;
    sourceInputsPretrimmed?: boolean;
  } = {},
): { filterComplex: string; outputLabel: string } | undefined {
  if (audioClips.length === 0 && !options.includeBgm) return undefined;

  const parts: string[] = [];
  const labels: string[] = ["[a_silent]"];
  parts.push(
    `[1:a]atrim=start=0:duration=${ffmpegNumber(totalDurationSec)},asetpts=PTS-STARTPTS[a_silent]`,
  );

  audioClips.forEach((clip, index) => {
    const inputIndex = index + 2;
    const label = `a${index}`;
    const delaySec = options.audioDelaySecByClipId?.get(clip.clipId) ?? (clip.timelineInFrame / fps);
    const filters = [
      `atrim=start=${options.sourceInputsPretrimmed ? "0" : ffmpegNumber(clip.startSec)}:duration=${ffmpegNumber(clip.durationSec)}`,
      "asetpts=PTS-STARTPTS",
      audioGainFilter(clip),
      ...audioFadeFilters(clip, fps),
      "aresample=48000",
      "aformat=channel_layouts=stereo",
      `adelay=${ffmpegAudioDelay(delaySec * 1000)}`,
    ].filter(Boolean);
    parts.push(`[${inputIndex}:a]${filters.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });

  if (options.includeBgm) {
    const inputIndex = audioClips.length + 2;
    const label = "bgm";
    const gain = options.bgmGain ?? 0.25;
    parts.push(
      `[${inputIndex}:a]atrim=start=0:duration=${ffmpegNumber(totalDurationSec)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(4)},aresample=48000,aformat=channel_layouts=stereo[${label}]`,
    );
    labels.push(`[${label}]`);
  }

  if (labels.length === 1) {
    parts.push(`${labels[0]}atrim=start=0:duration=${ffmpegNumber(totalDurationSec)}[aout]`);
  } else {
    parts.push(
      `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=start=0:duration=${ffmpegNumber(totalDurationSec)}[aout]`,
    );
  }

  const filterComplex = parts.join(";");
  assertSafeAudioDelayFilterOrder(filterComplex);
  return {
    filterComplex,
    outputLabel: "aout",
  };
}

export function buildTimelineAudioMuxArgs(
  videoPath: string,
  outputPath: string,
  audioClips: RenderAudioClip[],
  totalDurationSec: number,
  fps: number,
  bgmPath?: string,
  audioDelaySecByClipId?: Map<string, number>,
): string[] {
  const audioGraph = buildTimelineAudioMixFilter(audioClips, totalDurationSec, fps, {
    includeBgm: !!bgmPath,
    audioDelaySecByClipId,
    sourceInputsPretrimmed: true,
  });
  if (!audioGraph) {
    return ["-i", videoPath, "-c", "copy", outputPath];
  }

  const audioInputs = audioClips.flatMap((clip) => [
    "-ss",
    ffmpegNumber(clip.startSec),
    "-t",
    ffmpegNumber(clip.durationSec),
    "-i",
    clip.sourcePath,
  ]);
  const bgmInput = bgmPath ? ["-stream_loop", "-1", "-i", bgmPath] : [];
  return [
    "-i",
    videoPath,
    "-f",
    "lavfi",
    "-t",
    ffmpegNumber(totalDurationSec),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    ...audioInputs,
    ...bgmInput,
    "-filter_complex",
    audioGraph.filterComplex,
    "-map",
    "0:v:0",
    "-map",
    `[${audioGraph.outputLabel}]`,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-shortest",
    outputPath,
  ];
}

function roundSec(value: number): number {
  return Number(value.toFixed(3));
}

function effectiveXfadeDuration(
  requestedDurationSec: number,
  currentDurationSec: number,
  nextDurationSec: number,
): number {
  const maxDuration = Math.min(currentDurationSec, nextDurationSec);
  const safeMaxDuration = Math.max(0.001, maxDuration - XFADE_DURATION_EPSILON_SEC);
  return Math.max(0.001, Math.min(requestedDurationSec, safeMaxDuration));
}

function computeCrossfadeOverlapSec(groups: RenderGroup[]): number {
  if (groups.length < 2) return 0;

  let currentDurationSec = groups[0].durationSec;
  let overlapSec = 0;

  for (let index = 1; index < groups.length; index += 1) {
    const group = groups[index];
    const requestedDurationSec = group.transitionIn?.durationSec ?? 0.5;
    const durationSec = effectiveXfadeDuration(
      requestedDurationSec,
      currentDurationSec,
      group.durationSec,
    );
    overlapSec += durationSec;
    currentDurationSec += group.durationSec - durationSec;
  }

  return overlapSec;
}

export function computeRenderDurationAccounting(
  clips: RenderClip[],
  groups: RenderGroup[],
  fps: number,
): RenderDurationAccounting {
  if (clips.length === 0) {
    return {
      timeline_span_sec: 0,
      timeline_content_sec: 0,
      gap_sec: 0,
      gap_count: 0,
      crossfade_overlap_sec: 0,
      source_clamp_sec: 0,
      expected_rendered_sec: 0,
    };
  }

  const sortedClips = [...clips].sort((a, b) => a.timelineInFrame - b.timelineInFrame);
  const timelineSpanSec = Math.max(...sortedClips.map((clip) => clip.timelineOutFrame)) / fps;
  const timelineContentSec = sortedClips.reduce((sum, clip) => sum + clip.timelineDurationSec, 0);
  const sourceClampSec = sortedClips.reduce(
    (sum, clip) => sum + Math.max(0, clip.timelineDurationSec - clip.durationSec),
    0,
  );

  let gapCount = 0;
  let previousOutFrame = 0;
  for (const clip of sortedClips) {
    if (clip.timelineInFrame > previousOutFrame) gapCount += 1;
    previousOutFrame = Math.max(previousOutFrame, clip.timelineOutFrame);
  }

  const crossfadeOverlapSec = computeCrossfadeOverlapSec(groups);
  const expectedRenderedSec = Math.max(
    0,
    timelineContentSec - sourceClampSec - crossfadeOverlapSec,
  );

  return {
    timeline_span_sec: roundSec(timelineSpanSec),
    timeline_content_sec: roundSec(timelineContentSec),
    gap_sec: roundSec(Math.max(0, timelineSpanSec - timelineContentSec)),
    gap_count: gapCount,
    crossfade_overlap_sec: roundSec(crossfadeOverlapSec),
    source_clamp_sec: roundSec(sourceClampSec),
    expected_rendered_sec: roundSec(expectedRenderedSec),
  };
}

export function computeTimelineVideoDurationAccounting(
  timeline: TimelineDoc,
  fps: number,
): RenderDurationAccounting {
  const clips = extractVideoClips(timeline).map((clip): RenderClip => {
    const durationSec = clip.timeline_duration_frames / fps;
    return {
      clipId: clip.clip_id ?? clip.asset_id,
      segmentId: clip.segment_id,
      assetId: clip.asset_id,
      sourcePath: "",
      startSec: 0,
      durationSec,
      timelineInFrame: clip.timeline_in_frame ?? 0,
      timelineDurationSec: durationSec,
      sourceRangeDurationSec: durationSec,
      timelineOutFrame: (clip.timeline_in_frame ?? 0) + clip.timeline_duration_frames,
      role: clip.role,
    };
  });
  const transitions = extractCrossfadeTransitions(timeline, fps);
  const groups = buildRenderGroups(clips, clips.map((clip) => clip.clipId), transitions);
  return computeRenderDurationAccounting(clips, groups, fps);
}

export function computeAudioOnlyDurationAccounting(
  clips: TimelineClip[],
  fps: number,
): RenderDurationAccounting {
  const intervals = clips
    .map((clip) => ({
      start: Math.max(0, clip.timeline_in_frame ?? 0),
      end: Math.max(0, clip.timeline_in_frame ?? 0) + clip.timeline_duration_frames,
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (intervals.length === 0) {
    return {
      timeline_span_sec: 0,
      timeline_content_sec: 0,
      gap_sec: 0,
      gap_count: 0,
      crossfade_overlap_sec: 0,
      source_clamp_sec: 0,
      expected_rendered_sec: 0,
    };
  }

  let contentFrames = 0;
  let gapCount = intervals[0].start > 0 ? 1 : 0;
  let currentStart = intervals[0].start;
  let currentEnd = intervals[0].end;
  for (const interval of intervals.slice(1)) {
    if (interval.start > currentEnd) {
      contentFrames += currentEnd - currentStart;
      gapCount += 1;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else {
      currentEnd = Math.max(currentEnd, interval.end);
    }
  }
  contentFrames += currentEnd - currentStart;
  const timelineSpanFrames = Math.max(...intervals.map((interval) => interval.end));

  return {
    timeline_span_sec: roundSec(timelineSpanFrames / fps),
    timeline_content_sec: roundSec(contentFrames / fps),
    gap_sec: roundSec((timelineSpanFrames - contentFrames) / fps),
    gap_count: gapCount,
    crossfade_overlap_sec: 0,
    source_clamp_sec: 0,
    expected_rendered_sec: roundSec(timelineSpanFrames / fps),
  };
}

export function validateRenderDurationAccounting(
  accounting: RenderDurationAccounting,
  actualRenderedSec: number,
  warn: (message: string) => void = console.warn,
  thresholdSec: number = DURATION_PARITY_THRESHOLD_SEC,
): RenderDurationAccounting {
  const parityDeltaSec = actualRenderedSec - accounting.expected_rendered_sec;
  const effectiveThresholdSec = Math.max(
    thresholdSec,
    accounting.expected_rendered_sec * DURATION_PARITY_RELATIVE_THRESHOLD,
  );
  const parityPass = Math.abs(parityDeltaSec) <= effectiveThresholdSec;
  const validated = {
    ...accounting,
    actual_rendered_sec: roundSec(actualRenderedSec),
    parity_delta_sec: roundSec(parityDeltaSec),
    parity_tolerance_sec: roundSec(effectiveThresholdSec),
    parity_pass: parityPass,
  };

  if (!parityPass) {
    warn(
      `Warning: render duration parity delta ${validated.parity_delta_sec.toFixed(3)}s exceeds ${validated.parity_tolerance_sec.toFixed(3)}s; expected ${accounting.expected_rendered_sec.toFixed(3)}s, actual ${validated.actual_rendered_sec.toFixed(3)}s`,
    );
  }

  return validated;
}

export function buildXfadeFilterGraph(segments: XfadeSegment[]): XfadeFilterGraph | undefined {
  if (segments.length < 2) return undefined;

  const parts: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    parts.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
  }

  let currentLabel = "v0";
  let currentDurationSec = segments[0].durationSec;

  for (let index = 1; index < segments.length; index += 1) {
    const requestedDurationSec = segments[index].transitionIn?.durationSec ?? 0.5;
    const durationSec = effectiveXfadeDuration(
      requestedDurationSec,
      currentDurationSec,
      segments[index].durationSec,
    );
    const offsetSec = Math.max(0, currentDurationSec - durationSec);
    const outputLabel = index === segments.length - 1 ? "vout" : `xf${index}`;

    parts.push(
      `[${currentLabel}][v${index}]xfade=transition=fade:duration=${ffmpegNumber(durationSec)}:offset=${ffmpegNumber(offsetSec)}[${outputLabel}]`,
    );

    currentLabel = outputLabel;
    currentDurationSec += segments[index].durationSec - durationSec;
  }

  return {
    filterComplex: parts.join(";"),
    outputLabel: currentLabel,
    durationSec: currentDurationSec,
    xfadeCount: segments.length - 1,
  };
}

export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned invalid duration for ${filePath}`);
  }
  return duration;
}

export async function probeVideoDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const durationText = stdout.trim().split(/\r?\n/).find((line) => line.trim().length > 0);
  const duration = Number.parseFloat(durationText ?? "");
  if (Number.isFinite(duration) && duration > 0) return duration;

  return probeDurationSec(filePath);
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function findBgmCandidates(
  projectPath: string,
  probeDuration: (filePath: string) => Promise<number> = probeDurationSec,
): Promise<BgmCandidate[]> {
  const mediaDir = path.join(path.resolve(projectPath), "02_media");
  const bgmFiles = scanFiles(mediaDir, BGM_EXTENSIONS)
    .filter((filePath) => path.basename(filePath).toLowerCase().startsWith("bgm"));
  const candidates: BgmCandidate[] = [];

  for (const filePath of bgmFiles) {
    try {
      candidates.push({ path: filePath, durationSec: await probeDuration(filePath) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: skipping BGM candidate ${filePath}: ${message}`);
    }
  }

  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

export function selectBgmCandidate(
  candidates: BgmCandidate[],
  targetDurationSec: number,
): BgmCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.durationSec >= targetDurationSec)
    .sort((a, b) => (a.durationSec - targetDurationSec) - (b.durationSec - targetDurationSec))[0];
}

function resolveUserPath(projectPath: string, userPath: string): string {
  if (path.isAbsolute(userPath)) return userPath;

  const cwdPath = path.resolve(userPath);
  if (fs.existsSync(cwdPath)) return cwdPath;

  return path.resolve(projectPath, userPath);
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", ...args], { maxBuffer: 1024 * 1024 * 16 });
}

export function buildHardCutGroupFfmpegArgs(
  concatListPath: string,
  groupPath: string,
  opts: RenderHardCutGroupOptions,
): string[] {
  if (!opts.normalizeTimestamps) {
    return ["-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", groupPath];
  }

  return [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    ffmpegNumber(opts.fps),
    "-an",
    groupPath,
  ];
}

async function renderHardCutGroup(
  group: RenderGroup,
  index: number,
  tempDir: string,
  opts: RenderHardCutGroupOptions,
): Promise<string> {
  if (group.clipPaths.length === 1) return group.clipPaths[0];

  const concatListPath = path.join(tempDir, `group-${String(index + 1).padStart(4, "0")}.txt`);
  const groupPath = path.join(tempDir, `group-${String(index + 1).padStart(4, "0")}.mp4`);
  writeConcatList(concatListPath, group.clipPaths);
  await runFfmpeg(buildHardCutGroupFfmpegArgs(concatListPath, groupPath, opts));
  return groupPath;
}

async function renderXfadeGraph(
  segments: XfadeSegment[],
  graph: XfadeFilterGraph,
  outputPath: string,
): Promise<void> {
  const inputArgs = segments.flatMap((segment) => ["-i", segment.path]);
  await runFfmpeg([
    ...inputArgs,
    "-filter_complex",
    graph.filterComplex,
    "-map",
    `[${graph.outputLabel}]`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "use_metadata_tags",
    "-metadata",
    `video_os_xfade_count=${graph.xfadeCount}`,
    outputPath,
  ]);
}

async function renderIterativeXfades(
  segments: XfadeSegment[],
  tempDir: string,
): Promise<{ outputPath: string; durationSec: number; xfadeCount: number }> {
  let currentPath = segments[0].path;
  let currentDurationSec = segments[0].durationSec;
  let xfadeCount = 0;

  for (let index = 1; index < segments.length; index += 1) {
    const next = segments[index];
    const requestedDurationSec = next.transitionIn?.durationSec ?? 0.5;
    const durationSec = effectiveXfadeDuration(
      requestedDurationSec,
      currentDurationSec,
      next.durationSec,
    );
    const offsetSec = Math.max(0, currentDurationSec - durationSec);
    const outputPath = path.join(tempDir, `xfade-${String(index).padStart(4, "0")}.mp4`);
    const filter = [
      "[0:v]settb=AVTB,setpts=PTS-STARTPTS[v0]",
      "[1:v]settb=AVTB,setpts=PTS-STARTPTS[v1]",
      `[v0][v1]xfade=transition=fade:duration=${ffmpegNumber(durationSec)}:offset=${ffmpegNumber(offsetSec)}[vout]`,
    ].join(";");

    await runFfmpeg([
      "-i",
      currentPath,
      "-i",
      next.path,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "use_metadata_tags",
      "-metadata",
      `video_os_xfade_count=${xfadeCount + 1}`,
      outputPath,
    ]);

    xfadeCount += 1;
    currentPath = outputPath;
    currentDurationSec = await probeVideoDurationSec(currentPath);
  }

  return {
    outputPath: currentPath,
    durationSec: currentDurationSec,
    xfadeCount,
  };
}

async function assembleVideoFromGroups(
  groups: RenderGroup[],
  tempDir: string,
  fps: number,
): Promise<{ outputPath: string; durationSec: number; xfadeCount: number }> {
  if (groups.length === 0) throw new Error("No render groups found");

  const groupPaths: string[] = [];
  const willUseXfade = groups.length > 1;
  for (let index = 0; index < groups.length; index += 1) {
    groupPaths.push(await renderHardCutGroup(groups[index], index, tempDir, {
      fps,
      normalizeTimestamps: willUseXfade,
    }));
  }

  if (groupPaths.length === 1) {
    return {
      outputPath: groupPaths[0],
      durationSec: await probeVideoDurationSec(groupPaths[0]),
      xfadeCount: 0,
    };
  }

  const groupDurations = await Promise.all(groupPaths.map((groupPath) => probeVideoDurationSec(groupPath)));
  const segments: XfadeSegment[] = groups.map((group, index) => ({
    path: groupPaths[index],
    durationSec: groupDurations[index],
    transitionIn: group.transitionIn,
  }));
  const graph = buildXfadeFilterGraph(segments);
  if (!graph) {
    return {
      outputPath: groupPaths[0],
      durationSec: groupDurations[0],
      xfadeCount: 0,
    };
  }

  const graphOutputPath = path.join(tempDir, "rough-cut-video.mp4");
  await renderXfadeGraph(segments, graph, graphOutputPath);
  const graphDurationSec = await probeVideoDurationSec(graphOutputPath);
  if (graphDurationSec >= graph.durationSec - 1) {
    return {
      outputPath: graphOutputPath,
      durationSec: graphDurationSec,
      xfadeCount: graph.xfadeCount,
    };
  }

  console.warn(
    `Warning: xfade graph duration ${graphDurationSec.toFixed(3)}s was shorter than expected ${graph.durationSec.toFixed(3)}s; retrying iterative merge`,
  );
  return renderIterativeXfades(segments, tempDir);
}

export async function renderRoughCut(args: RenderArgs): Promise<RenderSummary> {
  const projectPath = path.resolve(args.projectPath);
  const timelinePath = args.timelinePath
    ? path.resolve(args.timelinePath)
    : path.join(projectPath, "05_timeline", "timeline.json");
  if (!fs.existsSync(timelinePath)) throw new Error(`Timeline not found: ${timelinePath}`);

  const timeline = readJson<TimelineDoc>(timelinePath);
  assertTimelineRenderSupported(timeline, { projectDir: projectPath, timelinePath });
  const fps = getTimelineFps(timeline);
  const sourceMap = ensureSourceMap(projectPath);
  const reuseVideoPath = args.reuseVideoPath
    ? resolveUserPath(projectPath, args.reuseVideoPath)
    : undefined;
  const reuseFreshnessBefore = reuseVideoPath
    ? assessRenderArtifactFreshness(projectPath, reuseVideoPath)
    : undefined;
  if (reuseFreshnessBefore && reuseFreshnessBefore.status !== "fresh") {
    throw new Error(
      `Reusable video lacks fresh canonical source identity metadata: ${reuseFreshnessBefore.reason ?? reuseFreshnessBefore.status}`,
    );
  }
  const outputWidth = timeline.sequence?.width;
  const outputHeight = timeline.sequence?.height;
  if (
    !Number.isInteger(outputWidth) ||
    !Number.isInteger(outputHeight) ||
    (outputWidth ?? 0) <= 0 ||
    (outputHeight ?? 0) <= 0
  ) {
    throw new Error("Timeline sequence width and height must be positive integers");
  }
  const sourceInputsBefore = createSourceInputAttestation(projectPath, {
    timelinePath,
    includeAudio: !args.noAudio,
  });
  const outputPath = args.outputPath
    ? resolveUserPath(projectPath, args.outputPath)
    : path.join(projectPath, "09_output", "rough-cut.mp4");
  const canonicalInputs = resolveCanonicalRenderInputs(timeline as never, {
    projectDir: projectPath,
    timelinePath,
    includeAudio: !args.noAudio,
  });
  if (canonicalInputs.imageAssetIds.size > 0) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const assembly = await assembleTimelineToMp4({
      projectDir: projectPath,
      timelinePath,
      outputPath,
      includeAudio: !args.noAudio,
    });
    const actualRenderedSec = await probeVideoDurationSec(outputPath);
    const durationAccounting = validateRenderDurationAccounting(
      computeTimelineVideoDurationAccounting(timeline, fps),
      actualRenderedSec,
    );
    writeRenderFreshnessMetadata(projectPath, outputPath, { sourceInputsBefore });
    return {
      outputPath,
      clipCount: extractVideoClips(timeline).length,
      audioClipCount: assembly.audioClipCount,
      durationSec: actualRenderedSec,
      fileSizeBytes: fs.statSync(outputPath).size,
      xfadeCount: extractCrossfadeTransitions(timeline, fps).size,
      durationAccounting,
    };
  }
  const clips = buildRenderClips(
    extractVideoClips(timeline),
    sourceMap,
    fps,
    console.warn,
    { allowEndingPostroll: true },
  );
  const rawTimelineAudioClips = extractAudioClips(timeline);
  const timelineAudioClips = buildRenderAudioClips(
    rawTimelineAudioClips,
    sourceMap,
    fps,
    console.warn,
    { audioMixPolicy: timeline.audio_mix },
  );
  if (clips.length === 0) {
    if (rawTimelineAudioClips.length === 0 || args.noAudio) {
      throw new Error("No renderable video clips found");
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const assembly = await assembleTimelineToMp4({
      projectDir: projectPath,
      timelinePath,
      outputPath,
    });
    const actualRenderedSec = await probeVideoDurationSec(outputPath);
    const durationAccounting = computeAudioOnlyDurationAccounting(rawTimelineAudioClips, fps);
    const validatedAccounting = validateRenderDurationAccounting(
      durationAccounting,
      actualRenderedSec,
    );
    atomicWriteJson(path.join(path.dirname(outputPath), "render-report.json"), {
      ...validatedAccounting,
      render_mode: "audio_only_timeline_assembler",
      placeholder_video: "black",
      video_clip_count: 0,
      video_segment_count: assembly.videoSegmentCount,
      audio_clip_count: assembly.audioClipCount,
      audio_rendered: assembly.audioClipCount > 0,
      bgm_rendered: timelineAudioClips.some((clip) =>
        clip.role === "bgm" || clip.role === "music"
      ),
      audio_timing_mode: "canonical_timeline_frames",
      audio_timeline_scale: 1,
    });
    writeRenderFreshnessMetadata(projectPath, outputPath, { sourceInputsBefore });
    return {
      outputPath,
      clipCount: 0,
      audioClipCount: assembly.audioClipCount,
      durationSec: actualRenderedSec,
      fileSizeBytes: fs.statSync(outputPath).size,
      xfadeCount: 0,
      durationAccounting: validatedAccounting,
    };
  }

  const crossfades = extractCrossfadeTransitions(timeline, fps);
  const plannedGroups = buildRenderGroups(clips, clips.map((clip) => clip.clipId), crossfades);
  const initialDurationAccounting = computeRenderDurationAccounting(clips, plannedGroups, fps);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rough-cut-"));
  try {
    let videoAssembly: { outputPath: string; durationSec: number; xfadeCount: number };
    let renderedDurationSecByVideoClipId: Map<string, number> | undefined;
    if (reuseVideoPath) {
      if (!fs.existsSync(reuseVideoPath)) {
        throw new Error(`Reusable video not found: ${reuseVideoPath}`);
      }
      videoAssembly = {
        outputPath: reuseVideoPath,
        durationSec: await probeVideoDurationSec(reuseVideoPath),
        xfadeCount: crossfades.size,
      };
      validateRenderDurationAccounting(initialDurationAccounting, videoAssembly.durationSec);
      renderedDurationSecByVideoClipId = loadVideoAssemblyTimingManifest(
        projectPath,
        timelinePath,
        fps,
        videoAssembly.durationSec,
        clips,
      );
    } else {
      const tmpClipPaths: string[] = [];
      renderedDurationSecByVideoClipId = new Map<string, number>();
      for (let index = 0; index < clips.length; index++) {
        const clip = clips[index];
        const tmpClip = path.join(tempDir, `clip-${String(index + 1).padStart(4, "0")}.mp4`);
        const videoFilters = buildClipVideoFilters(clip, fps, {
          applyEndingFade: !args.deferEndingFade,
          outputWidth,
          outputHeight,
        });
        await runFfmpeg([
          "-ss",
          String(clip.startSec),
          "-i",
          clip.sourcePath,
          "-t",
          String(clip.durationSec),
          "-vf",
          videoFilters,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          tmpClip,
        ]);
        tmpClipPaths.push(tmpClip);
        renderedDurationSecByVideoClipId.set(clip.clipId, await probeVideoDurationSec(tmpClip));
      }

      const groups = buildRenderGroups(clips, tmpClipPaths, crossfades);
      videoAssembly = await assembleVideoFromGroups(groups, tempDir, fps);
      writeVideoAssemblyTimingManifest(
        projectPath,
        timelinePath,
        fps,
        videoAssembly.durationSec,
        clips,
        renderedDurationSecByVideoClipId,
      );
    }

    const audioClips: RenderAudioClip[] = [];
    for (const clip of timelineAudioClips) {
      if (await hasAudioStream(clip.sourcePath)) {
        audioClips.push(clip);
      } else {
        console.warn(`Warning: skipping audio clip ${clip.clipId}; source has no audio stream: ${clip.sourcePath}`);
      }
    }
    if (!args.noAudio) {
      assertTimelineAudioVideoSync(clips, audioClips, fps);
    }

    let bgmPath: string | undefined;
    if (!args.noAudio) {
      const bgmAssetId = timeline.audio_mix?.bgm_asset_id;
      if (args.bgmPath) {
        bgmPath = resolveUserPath(projectPath, args.bgmPath);
        const attestedBgmPath = bgmAssetId ? sourceMap.get(bgmAssetId)?.source_locator : undefined;
        if (!attestedBgmPath || path.resolve(attestedBgmPath) !== path.resolve(bgmPath)) {
          throw new Error(
            "Explicit --bgm must resolve to timeline.audio_mix.bgm_asset_id in source_map.json",
          );
        }
      } else if (bgmAssetId) {
        bgmPath = sourceMap.get(bgmAssetId)?.source_locator;
        if (!bgmPath) {
          throw new Error(`Missing source_map entry for timeline BGM asset ${bgmAssetId}`);
        }
      }
    }

    if (!args.noAudio && (audioClips.length > 0 || bgmPath)) {
      if (bgmPath && !fs.existsSync(bgmPath)) throw new Error(`BGM file not found: ${bgmPath}`);
      const metadataArgs = videoAssembly.xfadeCount > 0
        ? ["-metadata", `video_os_xfade_count=${videoAssembly.xfadeCount}`]
        : [];
      const audioTimelineScale = renderedDurationSecByVideoClipId
        ? 1
        : initialDurationAccounting.expected_rendered_sec > 0
        ? videoAssembly.durationSec / initialDurationAccounting.expected_rendered_sec
        : 1;
      const audioDelaySecByClipId = buildAudioDelaySecByClipId(
        audioClips,
        clips,
        crossfades,
        audioTimelineScale,
        renderedDurationSecByVideoClipId,
      );
      const muxArgs = buildTimelineAudioMuxArgs(
        videoAssembly.outputPath,
        outputPath,
        audioClips,
        videoAssembly.durationSec,
        fps,
        bgmPath,
        audioDelaySecByClipId,
      );
      muxArgs.splice(muxArgs.length - 1, 0,
        "-movflags",
        "use_metadata_tags",
        ...metadataArgs,
      );
      await runFfmpeg(muxArgs);
    } else {
      fs.copyFileSync(videoAssembly.outputPath, outputPath);
    }

    const actualRenderedSec = await probeVideoDurationSec(outputPath);
    const durationAccounting = validateRenderDurationAccounting(initialDurationAccounting, actualRenderedSec);
    if (reuseVideoPath && reuseFreshnessBefore) {
      const reuseFreshnessAfter = assessRenderArtifactFreshness(projectPath, reuseVideoPath);
      if (
        reuseFreshnessAfter.status !== "fresh" ||
        reuseFreshnessAfter.artifactHash !== reuseFreshnessBefore.artifactHash
      ) {
        throw new SourceInputAttestationError(
          "source_changed_during_render",
          `Reusable video changed while rendering: ${reuseVideoPath}`,
        );
      }
    }
    atomicWriteJson(path.join(path.dirname(outputPath), "render-report.json"), {
      ...durationAccounting,
      audio_clip_count: audioClips.length,
      audio_rendered: !args.noAudio && (audioClips.length > 0 || !!bgmPath),
      bgm_rendered: !!bgmPath,
      audio_timing_mode: renderedDurationSecByVideoClipId
        ? "exact_clip_durations"
        : "scaled_total_duration_fallback",
      audio_timeline_scale: renderedDurationSecByVideoClipId
        ? 1
        : initialDurationAccounting.expected_rendered_sec > 0
          ? Number((videoAssembly.durationSec / initialDurationAccounting.expected_rendered_sec).toFixed(6))
          : 1,
      ...(reuseFreshnessBefore?.artifactHash
        ? { reused_video_hash: reuseFreshnessBefore.artifactHash }
        : {}),
    });
    writeRenderFreshnessMetadata(projectPath, outputPath, { sourceInputsBefore });

    return {
      outputPath,
      clipCount: clips.length,
      audioClipCount: audioClips.length,
      durationSec: actualRenderedSec,
      fileSizeBytes: fs.statSync(outputPath).size,
      xfadeCount: videoAssembly.xfadeCount,
      durationAccounting,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const summary = await renderRoughCut(parseArgs(process.argv));
  console.log(`Rendered rough cut: ${summary.outputPath}`);
  console.log(`  Clips: ${summary.clipCount}`);
  console.log(`  Crossfades: ${summary.xfadeCount}`);
  console.log(`  Duration: ${summary.durationSec.toFixed(1)}s`);
  console.log(`  File size: ${(summary.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(JSON.stringify(summary.durationAccounting, null, 2));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Render failed: ${message}`);
    console.error(USAGE);
    process.exit(1);
  });
}
