import * as fs from "node:fs";
import * as path from "node:path";
import { loadBgmAnalysisFromProject } from "../media/bgm-analyzer.js";
import type { AssembledTimeline, CompilerDefaults, TimelineClip, Track } from "./types.js";
import type { BgmAnalysis } from "./transition-types.js";

export type CutQuantizeMode = "auto" | "on" | "off";
export type BeatSyncGridSource = "music_cues" | "music_cues_analysis_ref" | "bgm_analysis";
export type BeatSyncBoundaryStatus = "quantized" | "unchanged" | "skipped";
export type BeatSyncSkipReason = "speech_protected" | "max_shift_exceeded" | "min_duration";

export interface BeatSyncGrid {
  frames: number[];
  source: BeatSyncGridSource;
}

export interface BeatSyncBoundaryResult {
  track_id: string;
  left_clip_id: string;
  right_clip_id: string;
  cut_frame_before: number;
  cut_frame_after: number;
  nearest_grid_frame: number;
  shift_frames: number;
  status: BeatSyncBoundaryStatus;
  skip_reason?: BeatSyncSkipReason;
}

export interface BeatSyncCompileMetadata {
  version: "1";
  cut_quantize: CutQuantizeMode;
  enabled: boolean;
  disabled_reason?: "configured_off" | "no_beat_grid";
  source?: BeatSyncGridSource;
  grid_count: number;
  max_shift_frames: number;
  min_duration_frames: number;
  fps_num: number;
  boundaries: BeatSyncBoundaryResult[];
  counts: {
    quantized: number;
    unchanged: number;
    skipped: number;
    speech_protected: number;
    max_shift_exceeded: number;
    min_duration: number;
  };
}

interface MusicCuesGridDoc {
  music_asset?: {
    analysis_ref?: string;
  };
  cues?: Array<{
    entry_frame?: number;
    exit_frame?: number;
    beat_sync?: {
      enabled?: boolean;
      analysis_ref?: string;
      beats_sec?: number[];
      downbeats_sec?: number[];
    };
  }>;
}

export function resolveBeatSyncConfig(defaults: CompilerDefaults): {
  mode: CutQuantizeMode;
  maxShiftFrames: number;
} {
  const rawMode = defaults.beat_sync?.cut_quantize;
  const mode: CutQuantizeMode = rawMode === "on" || rawMode === "off" ? rawMode : "auto";
  const rawMax = defaults.beat_sync?.max_shift_frames;
  const maxShiftFrames = Number.isFinite(rawMax) && rawMax !== undefined
    ? Math.max(0, Math.floor(rawMax))
    : 12;
  return { mode, maxShiftFrames };
}

export function loadBeatSyncGridFromProject(projectPath: string, fpsNum: number): BeatSyncGrid | undefined {
  const musicCuesPath = path.join(projectPath, "07_package", "music_cues.json");
  if (fs.existsSync(musicCuesPath)) {
    const doc = readJson<MusicCuesGridDoc>(musicCuesPath);
    const cueGrid = doc ? gridFromMusicCues(doc, projectPath, fpsNum) : undefined;
    if (cueGrid && cueGrid.frames.length > 0) return cueGrid;
  }

  const bgm = loadBgmAnalysisFromProject(projectPath);
  if (bgm && bgm.analysis_status === "ready") {
    const frames = secondsToFrames([...safeSeconds(bgm.beats_sec), ...safeSeconds(bgm.downbeats_sec)], fpsNum, 0);
    if (frames.length > 0) return { frames, source: "bgm_analysis" };
  }

  return undefined;
}

export function applyCutBeatQuantize(
  assembled: AssembledTimeline,
  options: {
    mode: CutQuantizeMode;
    grid?: BeatSyncGrid;
    fpsNum: number;
    maxShiftFrames: number;
    minDurationFrames: number;
  },
): BeatSyncCompileMetadata | undefined {
  if (options.mode === "off") {
    return {
      version: "1",
      cut_quantize: "off",
      enabled: false,
      disabled_reason: "configured_off",
      grid_count: options.grid?.frames.length ?? 0,
      max_shift_frames: options.maxShiftFrames,
      min_duration_frames: options.minDurationFrames,
      fps_num: options.fpsNum,
      boundaries: [],
      counts: emptyCounts(),
    };
  }

  if (!options.grid || options.grid.frames.length === 0) {
    if (options.mode === "auto") return undefined;
    return {
      version: "1",
      cut_quantize: options.mode,
      enabled: false,
      disabled_reason: "no_beat_grid",
      grid_count: 0,
      max_shift_frames: options.maxShiftFrames,
      min_duration_frames: options.minDurationFrames,
      fps_num: options.fpsNum,
      boundaries: [],
      counts: emptyCounts(),
    };
  }

  const frames = uniqueSortedFrames(options.grid.frames);
  if (frames.length === 0) {
    if (options.mode === "auto") return undefined;
    return {
      version: "1",
      cut_quantize: options.mode,
      enabled: false,
      disabled_reason: "no_beat_grid",
      grid_count: 0,
      max_shift_frames: options.maxShiftFrames,
      min_duration_frames: options.minDurationFrames,
      fps_num: options.fpsNum,
      boundaries: [],
      counts: emptyCounts(),
    };
  }

  const boundaries: BeatSyncBoundaryResult[] = [];
  for (const track of assembled.tracks.video) {
    quantizeTrackBoundaries(track, frames, options, boundaries);
  }

  const counts = emptyCounts();
  for (const boundary of boundaries) {
    counts[boundary.status] += 1;
    if (boundary.skip_reason) counts[boundary.skip_reason] += 1;
  }

  return {
    version: "1",
    cut_quantize: options.mode,
    enabled: true,
    source: options.grid.source,
    grid_count: frames.length,
    max_shift_frames: options.maxShiftFrames,
    min_duration_frames: options.minDurationFrames,
    fps_num: options.fpsNum,
    boundaries,
    counts,
  };
}

function gridFromMusicCues(
  doc: MusicCuesGridDoc,
  projectPath: string,
  fpsNum: number,
): BeatSyncGrid | undefined {
  const frames: number[] = [];
  for (const cue of doc.cues ?? []) {
    if (cue.beat_sync?.enabled === false) continue;
    const entryFrame = integerOr(cue.entry_frame, 0);
    const exitFrame = Number.isFinite(cue.exit_frame) ? Math.floor(cue.exit_frame as number) : undefined;
    const cueSeconds = [
      ...safeSeconds(cue.beat_sync?.beats_sec),
      ...safeSeconds(cue.beat_sync?.downbeats_sec),
    ];
    frames.push(...secondsToFrames(cueSeconds, fpsNum, entryFrame, exitFrame));
  }
  const uniqueCueFrames = uniqueSortedFrames(frames);
  if (uniqueCueFrames.length > 0) return { frames: uniqueCueFrames, source: "music_cues" };

  const ref = firstAnalysisRef(doc);
  if (!ref) return undefined;
  const analysisPath = path.isAbsolute(ref) ? ref : path.join(projectPath, ref);
  const analysis = readJson<BgmAnalysis>(analysisPath);
  if (!analysis || analysis.analysis_status !== "ready") return undefined;

  const analysisFrames: number[] = [];
  for (const cue of doc.cues ?? []) {
    if (cue.beat_sync?.enabled === false) continue;
    const entryFrame = integerOr(cue.entry_frame, 0);
    const exitFrame = Number.isFinite(cue.exit_frame) ? Math.floor(cue.exit_frame as number) : undefined;
    analysisFrames.push(...secondsToFrames([
      ...safeSeconds(analysis.beats_sec),
      ...safeSeconds(analysis.downbeats_sec),
    ], fpsNum, entryFrame, exitFrame));
  }
  const uniqueAnalysisFrames = uniqueSortedFrames(analysisFrames);
  return uniqueAnalysisFrames.length > 0
    ? { frames: uniqueAnalysisFrames, source: "music_cues_analysis_ref" }
    : undefined;
}

function firstAnalysisRef(doc: MusicCuesGridDoc): string | undefined {
  if (doc.music_asset?.analysis_ref) return doc.music_asset.analysis_ref;
  for (const cue of doc.cues ?? []) {
    if (cue.beat_sync?.analysis_ref) return cue.beat_sync.analysis_ref;
  }
  return undefined;
}

function quantizeTrackBoundaries(
  track: Track,
  gridFrames: number[],
  options: {
    fpsNum: number;
    maxShiftFrames: number;
    minDurationFrames: number;
  },
  boundaries: BeatSyncBoundaryResult[],
): void {
  const clips = [...track.clips].sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id)
  );
  for (let i = 0; i < clips.length - 1; i += 1) {
    const left = clips[i];
    const right = clips[i + 1];
    const cutFrame = left.timeline_in_frame + left.timeline_duration_frames;
    if (cutFrame !== right.timeline_in_frame) continue;

    const nearest = nearestGridFrame(cutFrame, gridFrames);
    if (nearest === undefined) continue;

    const delta = nearest - cutFrame;
    const baseResult = {
      track_id: track.track_id,
      left_clip_id: left.clip_id,
      right_clip_id: right.clip_id,
      cut_frame_before: cutFrame,
      nearest_grid_frame: nearest,
      shift_frames: delta,
    };

    if (isSpeechProtectedBeatBoundary(left, right)) {
      boundaries.push({
        ...baseResult,
        cut_frame_after: cutFrame,
        status: "skipped",
        skip_reason: "speech_protected",
      });
      continue;
    }

    if (Math.abs(delta) > options.maxShiftFrames) {
      boundaries.push({
        ...baseResult,
        cut_frame_after: cutFrame,
        status: "skipped",
        skip_reason: "max_shift_exceeded",
      });
      continue;
    }

    if (delta === 0) {
      boundaries.push({
        ...baseResult,
        cut_frame_after: cutFrame,
        status: "unchanged",
      });
      continue;
    }

    if (!canApplyBoundaryShift(left, right, delta, options.minDurationFrames)) {
      boundaries.push({
        ...baseResult,
        cut_frame_after: cutFrame,
        status: "skipped",
        skip_reason: "min_duration",
      });
      continue;
    }

    applyBoundaryShift(left, right, delta, options.fpsNum);
    boundaries.push({
      ...baseResult,
      cut_frame_after: nearest,
      status: "quantized",
    });
  }
}

function canApplyBoundaryShift(
  left: TimelineClip,
  right: TimelineClip,
  delta: number,
  minDurationFrames: number,
): boolean {
  const minFrames = Math.max(1, Math.floor(minDurationFrames));
  if (delta > 0) return right.timeline_duration_frames - delta >= minFrames;
  return left.timeline_duration_frames + delta >= minFrames;
}

function applyBoundaryShift(
  left: TimelineClip,
  right: TimelineClip,
  delta: number,
  fpsNum: number,
): void {
  const usPerFrame = 1_000_000 / fpsNum;
  const deltaUs = Math.round(delta * usPerFrame);

  left.timeline_duration_frames += delta;
  left.src_out_us += deltaUs;
  right.timeline_in_frame += delta;
  right.timeline_duration_frames -= delta;
  right.src_in_us += deltaUs;
}

export function isSpeechProtectedBeatBoundary(left: TimelineClip, right: TimelineClip): boolean {
  return isTalkingHeadSnap(left.metadata, "snapped_out") ||
    isTalkingHeadSnap(right.metadata, "snapped_in");
}

function isTalkingHeadSnap(metadata: Record<string, unknown> | undefined, field: "snapped_in" | "snapped_out"): boolean {
  const value = metadata?.talking_head_pacing;
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>)[field] === true;
}

function nearestGridFrame(frame: number, gridFrames: number[]): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const candidate of gridFrames) {
    const dist = Math.abs(candidate - frame);
    if (dist < bestDist || (dist === bestDist && (best === undefined || candidate < best))) {
      best = candidate;
      bestDist = dist;
    }
    if (candidate > frame && dist > bestDist) break;
  }
  return best;
}

function secondsToFrames(
  seconds: number[],
  fpsNum: number,
  offsetFrame: number,
  maxFrame?: number,
): number[] {
  return uniqueSortedFrames(seconds.map((sec) => offsetFrame + Math.round(sec * fpsNum)))
    .filter((frame) => maxFrame === undefined || frame <= maxFrame);
}

function safeSeconds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => Number.isFinite(value) && value >= 0);
}

function uniqueSortedFrames(frames: number[]): number[] {
  const sorted = frames
    .filter((frame) => Number.isFinite(frame) && frame >= 0)
    .map((frame) => Math.round(frame))
    .sort((a, b) => a - b);
  return sorted.filter((frame, index) => index === 0 || frame !== sorted[index - 1]);
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value as number) : fallback;
}

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function emptyCounts(): BeatSyncCompileMetadata["counts"] {
  return {
    quantized: 0,
    unchanged: 0,
    skipped: 0,
    speech_protected: 0,
    max_shift_exceeded: 0,
    min_duration: 0,
  };
}
