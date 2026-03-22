import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClipOutput, TimelineIR, TrackOutput } from "../compiler/types.js";
import { loadSourceMap, type LoadedSourceMap } from "../media/source-map.js";
import { buildAspectRatioFitFilter } from "./pipeline.js";

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
}

export interface AudioClipPlan {
  track_id: string;
  clip_id: string;
  asset_id: string;
  source_in_sec: number;
  source_out_sec: number;
  timeline_start_sec: number;
  delay_ms: number;
}

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

export function buildVideoTrimArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  width: number,
  height: number,
  fps: number,
): string[] {
  return [
    "-y",
    "-ss", formatFfmpegTimestamp(startSec),
    "-to", formatFfmpegTimestamp(endSec),
    "-i", inputPath,
    "-map", "0:v:0",
    "-vf", buildAspectRatioFitFilter(width, height),
    "-an",
    "-r", String(fps),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

export function buildGapVideoArgs(
  outputPath: string,
  durationSec: number,
  width: number,
  height: number,
  fps: number,
): string[] {
  return [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
    "-t", formatFfmpegTimestamp(durationSec),
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

export function buildVideoConcatArgs(
  concatListPath: string,
  outputPath: string,
  fps: number,
): string[] {
  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-an",
    "-r", String(fps),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

export function buildAudioTrimArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  sampleRate: number,
  audioChannels: 1 | 2,
): string[] {
  return [
    "-y",
    "-ss", formatFfmpegTimestamp(startSec),
    "-to", formatFfmpegTimestamp(endSec),
    "-i", inputPath,
    "-vn",
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
    `${inputs}amix=inputs=${delaysMs.length + 1}:duration=longest:dropout_transition=0[aout]`,
  );

  return steps.join(";");
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
): string[] {
  return [
    "-y",
    "-f", "lavfi",
    "-t", formatFfmpegTimestamp(totalDurationSec),
    "-i", `anullsrc=channel_layout=${audioChannels === 1 ? "mono" : "stereo"}:sample_rate=${sampleRate}`,
    ...inputPaths.flatMap((inputPath) => ["-i", inputPath]),
    "-filter_complex", buildAudioMixFilter(delaysMs, audioChannels),
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
): string[] {
  return [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "copy",
    outputPath,
  ];
}

export function buildVideoAssemblyPlan(timeline: TimelineIR): VideoSegmentPlan[] {
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
    });
  }

  return plans;
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
        timeline_start_sec: clip.timeline_in_frame / fps,
        delay_ms: Math.round((clip.timeline_in_frame / fps) * 1000),
      });
    }
  }

  return plans;
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
  const fps = getTimelineFps(timeline);
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
  const workingDir = fs.mkdtempSync(path.join(workingDirRoot, "vos-assembler-"));
  const timelineDir = path.dirname(timelinePath);
  const resolver = createSourceResolver(projectDir, timelineDir);
  const videoPlans = buildVideoAssemblyPlan(timeline);
  const audioPlans = buildAudioAssemblyPlan(timeline);
  const totalDurationSec = totalFrames / fps;

  try {
    const renderedVideoSegments: string[] = [];

    for (let i = 0; i < videoPlans.length; i++) {
      const plan = videoPlans[i];
      const segmentPath = path.join(workingDir, `video-segment-${String(i + 1).padStart(4, "0")}.mp4`);
      if (plan.kind === "gap") {
        await runFfmpeg(execFileImpl, ffmpegBin, buildGapVideoArgs(
          segmentPath,
          plan.duration_sec,
          width,
          height,
          fps,
        ));
      } else {
        const clip = findClipById(timeline.tracks.video, plan.clip_id!);
        const sourcePath = resolveClipSourcePath(resolver, clip);
        await runFfmpeg(execFileImpl, ffmpegBin, buildVideoTrimArgs(
          sourcePath,
          segmentPath,
          plan.source_in_sec!,
          plan.source_out_sec!,
          width,
          height,
          fps,
        ));
      }
      renderedVideoSegments.push(segmentPath);
    }

    const concatListPath = path.join(workingDir, "video.concat.txt");
    fs.writeFileSync(concatListPath, buildConcatListContent(renderedVideoSegments), "utf-8");
    const videoOnlyPath = path.join(workingDir, "assembly.video.mp4");
    await runFfmpeg(execFileImpl, ffmpegBin, buildVideoConcatArgs(concatListPath, videoOnlyPath, fps));

    const renderedAudioSegments: string[] = [];
    const audioDelaysMs: number[] = [];
    for (let i = 0; i < audioPlans.length; i++) {
      const plan = audioPlans[i];
      const clip = findClipById(timeline.tracks.audio, plan.clip_id);
      const sourcePath = resolveClipSourcePath(resolver, clip);
      const segmentPath = path.join(workingDir, `audio-segment-${String(i + 1).padStart(4, "0")}.wav`);
      await runFfmpeg(execFileImpl, ffmpegBin, buildAudioTrimArgs(
        sourcePath,
        segmentPath,
        plan.source_in_sec,
        plan.source_out_sec,
        sampleRate,
        audioChannels,
      ));
      renderedAudioSegments.push(segmentPath);
      audioDelaysMs.push(plan.delay_ms);
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
      ));
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await runFfmpeg(execFileImpl, ffmpegBin, buildFinalAssemblyMuxArgs(
      videoOnlyPath,
      mixedAudioPath,
      outputPath,
    ));

    return {
      outputPath,
      workingDir,
      timelineDurationFrames: totalFrames,
      videoSegmentCount: videoPlans.length,
      audioClipCount: audioPlans.length,
    };
  } finally {
    if (cleanupTemp) {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  }
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
  };
}

function resolveClipSourcePath(
  ctx: SourceResolverContext,
  clip: ClipOutput,
): string {
  const previewClip = ctx.previewByClipId.get(clip.clip_id);
  const previewAsset = ctx.previewByAssetId.get(clip.asset_id) ?? [];
  const sourceEntry = ctx.sourceMap.entryMap.get(clip.asset_id);
  const asset = ctx.assetsById.get(clip.asset_id);

  const candidateStrings = [
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
