// Timeline Compiler — Main entry point
// Orchestrates Phase 1-5 to produce timeline.json from project artifacts.
// Pure, deterministic. No LLM calls. No randomness.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { normalize } from "./normalize.js";
import { scoreCandidates } from "./score.js";
import { assemble } from "./assemble.js";
import { applyAdaptiveTrim, applyUtteranceSnap, compactTrimmedClipsWithinBeats, type UtteranceSpan } from "./trim.js";
import { applyDurationAdjust } from "./duration-adjust.js";
import { resolve } from "./resolve.js";
import { buildTimelineIR, exportOtio, writePreviewManifest, writeTimeline } from "./export.js";
import { reorderAssembledSceneContinuity } from "./scene-order.js";
import { loadVisualCache, type CompileVisualCache } from "./visual-cache.js";
import { applyPatch } from "./patch.js";
import { resolveDurationPolicyFromBlueprint, resolveOutputDimensions, resolveTimelineOrder } from "./duration-helpers.js";
import { activateSkills, computeRegistryHash, getSkillMetadataTags, getUtteranceSnapConfig } from "../editorial/skill-registry.js";
import { loadProfiles } from "../editorial/policy-resolver.js";
import { adjacencyDecide, writeAdjacencyAnalysis, applyBeatSnap, hasCraftTransitions } from "./adjacency.js";
import { loadBgmAnalysisFromProject } from "../media/bgm-analyzer.js";
import { loadSourceMap } from "../media/source-map.js";
import { extractDurationUs, runFfprobe } from "../connectors/ffprobe.js";
import { attachAutoCaptions, resolveCaptionPolicy } from "../captions/timeline-captions.js";
import { materializePeakSignalsFromSegments } from "../artifacts/peak-materialization.js";
import {
  isMarlinEventClipTrimPlan,
  planClipTrims,
  type ClipTrimPlan,
  type ClipTrimPlanningContext,
} from "../agents/clip-trim-agent.js";
import type { BgmScoringContext } from "./score.js";
import type { MarlinEventsArtifact } from "../connectors/marlin-types.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { TimelineTransition } from "./transition-types.js";
import type {
  Candidate,
  CompileOptions,
  CompilerDefaults,
  CreativeBrief,
  AssembledTimeline,
  BriefAudioPolicy,
  CraftDirective,
  DurationPolicy,
  EditBlueprint,
  NormalizedBeat,
  SelectsCandidates,
  TimelineClip,
  TimelineIR,
  TrimHint,
} from "./types.js";

export type { TimelineIR, CompileOptions };
export { applyPatch } from "./patch.js";
export type { ReviewPatch, PatchResult, PatchError, PatchOperation } from "./patch.js";
export type { ResolutionReport } from "./resolve.js";

export const MIN_RENDERABLE_FRAMES = 12;

export interface CompileResult {
  timeline: TimelineIR;
  outputPath: string;
  otioPath: string;
  previewManifestPath: string;
  resolution: {
    resolved_overlaps: number;
    resolved_duplicates: number;
    resolved_invalid_ranges: number;
    duration_fit: boolean;
    total_frames: number;
    target_frames: number;
    duration_mode?: string;
    target_source?: string;
    min_target_frames?: number;
    max_target_frames?: number | null;
    duration_status?: string;
    duration_delta_frames?: number;
    duration_delta_pct?: number;
    content_frames?: number;
    content_fill_ratio?: number;
    gap_frames?: number;
    gap_count?: number;
    beat_fill?: Array<{ beat_id: string; target: number; actual: number; fill_ratio: number }>;
  };
  duration_policy?: DurationPolicy;
}

export interface DetectedBgm {
  filePath: string;
  filename: string;
  durationUs: number;
}

interface ResolvedAudioPolicy {
  mode: BriefAudioPolicy;
  source: "explicit_brief" | "profile_default" | "global_default";
  a1_loudnorm: boolean;
}

export interface MicroClipGuardResult {
  dropped: number;
  droppedClipIds: string[];
  droppedAudioClipIds: string[];
  minRenderableFrames: number;
}

/**
 * Load transcript utterance spans per asset from 03_analysis/transcripts.
 * Deterministic (files sorted, spans sorted). Returns an empty map when the
 * directory is absent so the compiler stays hermetic for projects without
 * speech analysis. Mirrors the review-side transcript reader.
 */
function loadProjectUtterances(projectPath: string): Map<string, UtteranceSpan[]> {
  const dir = path.join(projectPath, "03_analysis", "transcripts");
  const map = new Map<string, UtteranceSpan[]>();
  if (!fs.existsSync(dir)) return map;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    let parsed: { asset_id?: string; items?: Array<{ start_us?: number; end_us?: number }> };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    } catch {
      continue;
    }
    const assetId = parsed.asset_id;
    if (!assetId || !Array.isArray(parsed.items)) continue;
    const spans: UtteranceSpan[] = [];
    for (const item of parsed.items) {
      if (
        typeof item.start_us === "number" &&
        typeof item.end_us === "number" &&
        item.end_us > item.start_us
      ) {
        spans.push({ start_us: item.start_us, end_us: item.end_us });
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
      map.set(assetId, spans);
    }
  }
  return map;
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not find repo root (directory containing schemas/)");
}

function readYaml<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseYaml(raw) as T;
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function loadProjectSegments(projectPath: string): SegmentItem[] {
  const doc = readJsonIfExists<{ items?: SegmentItem[] }>(path.join(projectPath, "03_analysis", "segments.json"));
  if (!Array.isArray(doc?.items)) return [];
  return doc.items.filter((item): item is SegmentItem =>
    typeof item?.segment_id === "string" &&
    typeof item.asset_id === "string" &&
    typeof item.src_in_us === "number" &&
    typeof item.src_out_us === "number" &&
    item.src_out_us > item.src_in_us
  );
}

function loadProjectMarlinEvents(projectPath: string): MarlinEventsArtifact | undefined {
  const doc = readJsonIfExists<MarlinEventsArtifact>(path.join(projectPath, "03_analysis", "marlin_events.json"));
  return Array.isArray(doc?.items) ? doc : undefined;
}

function buildBeatCraftMap(beats: NormalizedBeat[]): Map<string, CraftDirective> {
  const map = new Map<string, CraftDirective>();
  for (const beat of beats) {
    if (beat.craft) map.set(beat.beat_id, beat.craft);
  }
  return map;
}

function buildClipTrimPlanningContext(
  beats: NormalizedBeat[],
  visualClips: TimelineClip[],
  usPerFrame: number,
): ClipTrimPlanningContext {
  const beatTargetDurationFramesById = new Map(
    beats.map((beat) => [beat.beat_id, beat.target_duration_frames]),
  );
  const sourceKeysByBeat = new Map<string, Set<string>>();
  const selectedBeatBySegmentId = new Map<string, string>();

  for (const clip of visualClips) {
    if (!beatTargetDurationFramesById.has(clip.beat_id)) continue;
    const sourceKeys = sourceKeysByBeat.get(clip.beat_id) ?? new Set<string>();
    sourceKeys.add(sourceRangeKey(clip));
    sourceKeysByBeat.set(clip.beat_id, sourceKeys);
    if (!selectedBeatBySegmentId.has(clip.segment_id)) {
      selectedBeatBySegmentId.set(clip.segment_id, clip.beat_id);
    }
  }

  const clipsInBeatById = new Map<string, number>();
  for (const beat of beats) {
    clipsInBeatById.set(beat.beat_id, Math.max(1, sourceKeysByBeat.get(beat.beat_id)?.size ?? 1));
  }

  return {
    usPerFrame,
    beatTargetDurationFramesById,
    clipsInBeatById,
    selectedBeatBySegmentId,
  };
}

function candidatesForAssembledClips(candidates: Candidate[], clips: TimelineClip[]): Candidate[] {
  const placedKeys = new Set(clips.map((clip) => sourceRangeKey(clip)));
  const selected: Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = sourceRangeKey(candidate);
    if (!placedKeys.has(key) || seen.has(key)) continue;
    selected.push(candidate);
    seen.add(key);
  }
  return selected;
}

function sourceRangeKey(item: { segment_id: string; src_in_us: number; src_out_us: number }): string {
  return `${item.segment_id}:${item.src_in_us}:${item.src_out_us}`;
}

export function compactGuideSingleTrackGaps(
  assembled: AssembledTimeline,
  beats: NormalizedBeat[] = [],
): void {
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (!v1Track || v1Track.clips.length <= 1) {
    syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
    alignBeatMarkersToPrimaryTrack(assembled, beats);
    return;
  }

  const ordered = [...v1Track.clips].sort(compareTimelineClips);
  let cursor = 0;
  for (const clip of ordered) {
    clip.timeline_in_frame = cursor;
    cursor += Math.max(0, clip.timeline_duration_frames);
  }
  v1Track.clips.splice(0, v1Track.clips.length, ...ordered);

  syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
  alignBeatMarkersToPrimaryTrack(assembled, beats);
}

function compareTimelineClips(left: TimelineClip, right: TimelineClip): number {
  return left.timeline_in_frame - right.timeline_in_frame ||
    left.clip_id.localeCompare(right.clip_id);
}

function syncGeneratedAudioMirrorsWithPrimaryVideo(assembled: AssembledTimeline): void {
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (!v1Track) return;

  const videoQueues = new Map<string, TimelineClip[]>();
  for (const clip of v1Track.clips) {
    for (const key of audioMirrorMatchKeys(clip)) {
      const queue = videoQueues.get(key) ?? [];
      queue.push(clip);
      videoQueues.set(key, queue);
    }
  }

  for (const track of assembled.tracks.audio) {
    for (const clip of track.clips) {
      if (!isGeneratedAudioMirror(clip)) continue;
      const videoClip = audioMirrorMatchKeys(clip)
        .map((key) => videoQueues.get(key))
        .find((queue): queue is TimelineClip[] => Boolean(queue?.length))
        ?.shift();
      if (!videoClip) continue;
      clip.timeline_in_frame = videoClip.timeline_in_frame;
      clip.timeline_duration_frames = videoClip.timeline_duration_frames;
      clip.src_in_us = videoClip.src_in_us;
      clip.src_out_us = videoClip.src_out_us;
      clip.beat_id = videoClip.beat_id;
    }
  }
}

function alignBeatMarkersToPrimaryTrack(
  assembled: AssembledTimeline,
  beats: NormalizedBeat[] = [],
): void {
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (!v1Track) return;

  const beatIds = new Set(beats.map((beat) => beat.beat_id));
  const firstFrameByBeat = new Map<string, number>();
  for (const clip of [...v1Track.clips].sort(compareTimelineClips)) {
    if (!firstFrameByBeat.has(clip.beat_id)) {
      firstFrameByBeat.set(clip.beat_id, clip.timeline_in_frame);
    }
  }

  for (const marker of assembled.markers) {
    if (marker.kind !== "beat") continue;
    const beatId = marker.label.split(":")[0]?.trim();
    if (!beatId || (beatIds.size > 0 && !beatIds.has(beatId))) continue;
    const frame = firstFrameByBeat.get(beatId);
    if (frame !== undefined) marker.frame = frame;
  }
}

function audioMirrorMatchKeys(clip: TimelineClip): string[] {
  const keys: string[] = [];
  if (clip.candidate_ref) keys.push(`candidate:${clip.candidate_ref}`);
  keys.push(`beat:${clip.beat_id}:${clip.segment_id}:${clip.asset_id}`);
  keys.push(`source:${clip.segment_id}:${clip.asset_id}:${clip.src_in_us}:${clip.src_out_us}`);
  return keys;
}

function refreshTransitionCutFrames(
  transitions: TimelineTransition[],
  assembled: AssembledTimeline,
): void {
  if (transitions.length === 0) return;

  const clipsById = new Map<string, TimelineClip>();
  for (const track of assembled.tracks.video) {
    for (const clip of track.clips) {
      clipsById.set(clip.clip_id, clip);
    }
  }

  for (const transition of transitions) {
    const leftClip = clipsById.get(transition.from_clip_id);
    const rightClip = clipsById.get(transition.to_clip_id);
    if (!leftClip || !rightClip) continue;
    const actualCutFrame = leftClip.timeline_in_frame + leftClip.timeline_duration_frames;
    transition.transition_params ??= {};
    const snapDelta = Number(transition.transition_params.snap_delta_frames ?? 0);
    transition.transition_params.cut_frame_after_snap = actualCutFrame;
    transition.transition_params.cut_frame_before_snap = actualCutFrame - snapDelta;
  }
}

function applyClipTrimPlansToCandidates(candidates: Candidate[], plans: ClipTrimPlan[]): void {
  const plansBySegment = new Map(plans.filter(isMarlinEventClipTrimPlan).map((plan) => [plan.segment_id, plan]));
  for (const candidate of candidates) {
    const plan = plansBySegment.get(candidate.segment_id);
    if (!plan) continue;

    const inUs = clampInteger(plan.best_in_us, candidate.src_in_us, candidate.src_out_us);
    const outUs = clampInteger(plan.best_out_us, candidate.src_in_us, candidate.src_out_us);
    if (outUs <= inUs) continue;

    const peakType = peakTypeForClipTrimTechnique(plan.technique);
    const nextHint: TrimHint = {
      ...(candidate.trim_hint ?? {}),
      source_center_us: Math.round((inUs + outUs) / 2),
      preferred_duration_us: outUs - inUs,
      window_start_us: inUs,
      window_end_us: outUs,
      recommended_in_us: inUs,
      recommended_out_us: outUs,
      interest_point_label: plan.rationale,
      interest_point_confidence: typeof plan.score === "number" ? clamp01(plan.score) : candidate.trim_hint?.interest_point_confidence,
      center_source: "precision_proxy_clip",
      rationale: plan.rationale,
    };
    if (plan.event_id) nextHint.peak_ref = plan.event_id;
    if (peakType) nextHint.peak_type = peakType;
    candidate.trim_hint = nextHint;

    if (plan.event_id || peakType || typeof plan.score === "number") {
      candidate.editorial_signals ??= {};
      if (plan.event_id) candidate.editorial_signals.peak_ref = plan.event_id;
      if (peakType) candidate.editorial_signals.peak_type = peakType;
      if (typeof plan.score === "number") candidate.editorial_signals.peak_strength_score = clamp01(plan.score);
      candidate.editorial_signals.peak_source_pass = "marlin_caption";
    }
  }
}

function peakTypeForClipTrimTechnique(technique: string): "action_peak" | "emotional_peak" | "visual_peak" | undefined {
  if (technique === "cut_on_action") return "action_peak";
  if (technique === "peak_hold" || technique === "post_action_hold") return "emotional_peak";
  if (technique === "clean_in_clean_out" || technique === "pre_roll_enter") return "visual_peak";
  return undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.max(min, Math.min(value, max)));
}

function readSourceVideoDimensions(
  projectPath: string,
  assetIds: Set<string>,
): Array<{ width: number; height: number }> {
  const assetsPath = path.join(projectPath, "03_analysis/assets.json");
  if (!fs.existsSync(assetsPath)) return [];

  try {
    const assetsDoc = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
      items?: Array<{
        asset_id?: string;
        video_stream?: { width?: number; height?: number };
      }>;
    };

    return (assetsDoc.items ?? [])
      .filter((item) =>
        !!item.video_stream &&
        (assetIds.size === 0 || (item.asset_id ? assetIds.has(item.asset_id) : false))
      )
      .map((item) => ({
        width: item.video_stream!.width ?? 0,
        height: item.video_stream!.height ?? 0,
      }))
      .filter((item) => item.width > 0 && item.height > 0);
  } catch {
    return [];
  }
}

export async function detectProjectBgm(
  projectPath: string,
  log: (message: string) => void = console.warn,
): Promise<DetectedBgm | undefined> {
  const mediaDir = path.join(path.resolve(projectPath), "02_media");
  if (!fs.existsSync(mediaDir)) return undefined;

  const bgmFiles = fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^bgm.*\.(mp3|wav)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  for (const filename of bgmFiles) {
    const filePath = path.join(mediaDir, filename);
    try {
      const durationUs = extractDurationUs(await runFfprobe(filePath));
      if (durationUs > 0) return { filePath, filename, durationUs };
      log(`Warning: skipping BGM candidate ${filename}: ffprobe returned no duration`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Warning: skipping BGM candidate ${filename}: ${message}`);
    }
  }

  return undefined;
}

function resolveBgmDurationUs(opts: CompileOptions, blueprint: EditBlueprint): number | undefined {
  if (typeof opts.bgm_duration_us === "number" && opts.bgm_duration_us > 0) {
    return opts.bgm_duration_us;
  }
  if (typeof blueprint.music_policy.bgm_duration_sec === "number" && blueprint.music_policy.bgm_duration_sec > 0) {
    return Math.round(blueprint.music_policy.bgm_duration_sec * 1_000_000);
  }
  return undefined;
}

function enforceDurationCapAfterTimingAdjustments(
  assembled: AssembledTimeline,
  maxDurationFrames: number | undefined,
  log: ((message: string) => void) | undefined,
): void {
  if (maxDurationFrames == null) return;

  let dropped = 0;
  for (const track of [...assembled.tracks.video, ...assembled.tracks.audio]) {
    const kept = track.clips.filter(
      (clip) => clip.timeline_in_frame + clip.timeline_duration_frames <= maxDurationFrames,
    );
    dropped += track.clips.length - kept.length;
    if (kept.length !== track.clips.length) {
      track.clips.splice(0, track.clips.length, ...kept);
    }
  }

  if (dropped > 0) {
    const emit = log ?? console.warn;
    emit(`Duration cap dropped ${dropped} clip(s) after timing adjustments beyond ${maxDurationFrames} frames`);
  }
}

export function dropUnintentionalMicroClips(
  assembled: AssembledTimeline,
  options: {
    minRenderableFrames?: number;
    beats?: NormalizedBeat[];
    log?: (message: string) => void;
  } = {},
): MicroClipGuardResult {
  const minRenderableFrames = Math.max(
    1,
    Math.floor(options.minRenderableFrames ?? MIN_RENDERABLE_FRAMES),
  );
  const result: MicroClipGuardResult = {
    dropped: 0,
    droppedClipIds: [],
    droppedAudioClipIds: [],
    minRenderableFrames,
  };
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (!v1Track) return result;

  const beatCraftById = new Map(
    (options.beats ?? []).map((beat) => [beat.beat_id, beat.craft]),
  );
  const droppedV1Clips: TimelineClip[] = [];
  for (const clip of v1Track.clips) {
    if (clip.timeline_duration_frames >= minRenderableFrames) continue;
    if (hasIntentionalShortClipMarker(clip, beatCraftById.get(clip.beat_id))) {
      annotateIntentionalShortClip(clip);
      continue;
    }
    droppedV1Clips.push(clip);
  }

  if (droppedV1Clips.length === 0) return result;

  const droppedClipIds = new Set(droppedV1Clips.map((clip) => clip.clip_id));
  const droppedMirrorKeys = new Set(droppedV1Clips.map(audioMirrorKey));
  const removalSpans = normalizeRemovalSpans(
    droppedV1Clips.map((clip) => ({
      startFrame: clip.timeline_in_frame,
      durationFrames: clip.timeline_duration_frames,
    })),
  );

  v1Track.clips.splice(
    0,
    v1Track.clips.length,
    ...v1Track.clips.filter((clip) => !droppedClipIds.has(clip.clip_id)),
  );

  for (const track of assembled.tracks.audio) {
    const kept = track.clips.filter((clip) => {
      const shouldDrop = isGeneratedAudioMirror(clip) && droppedMirrorKeys.has(audioMirrorKey(clip));
      if (shouldDrop) result.droppedAudioClipIds.push(clip.clip_id);
      return !shouldDrop;
    });
    if (kept.length !== track.clips.length) {
      track.clips.splice(0, track.clips.length, ...kept);
    }
  }

  retimeTimelineAfterRemovingSpans(assembled, removalSpans);

  result.dropped = droppedV1Clips.length;
  result.droppedClipIds = droppedV1Clips.map((clip) => clip.clip_id);
  const emit = options.log ?? console.warn;
  emit(`[compile] dropped ${result.dropped} micro-clip(s) below minimum renderable duration`);
  return result;
}

function hasIntentionalShortClipMarker(
  clip: TimelineClip,
  beatCraft: CraftDirective | undefined,
): boolean {
  if (beatCraft?.flash_cut === true) return true;
  const metadata = recordValue(clip.metadata);
  if (!metadata) return false;
  return hasShortClipMarker(metadata) ||
    hasShortClipMarker(recordValue(metadata.craft)) ||
    hasShortClipMarker(recordValue(metadata.editorial)) ||
    hasShortClipMarker(recordValue(metadata.trim));
}

function hasShortClipMarker(value: Record<string, unknown> | undefined): boolean {
  return value?.flash_cut === true ||
    value?.intentional_flash_cut === true ||
    value?.intentional_short_clip === true ||
    value?.intentional_micro_clip === true;
}

function annotateIntentionalShortClip(clip: TimelineClip): void {
  const metadata = recordValue(clip.metadata) ?? {};
  const craft = recordValue(metadata.craft) ?? {};
  craft.flash_cut = true;
  metadata.craft = craft;
  clip.metadata = metadata;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isGeneratedAudioMirror(clip: TimelineClip): boolean {
  return clip.motivation === "original clip audio" || clip.role === "nat_sound";
}

function audioMirrorKey(clip: TimelineClip): string {
  return [
    clip.segment_id,
    clip.asset_id,
    clip.src_in_us,
    clip.src_out_us,
    clip.timeline_in_frame,
    clip.timeline_duration_frames,
  ].join(":");
}

function normalizeRemovalSpans(
  spans: Array<{ startFrame: number; durationFrames: number }>,
): Array<{ startFrame: number; durationFrames: number }> {
  const sorted = spans
    .filter((span) => span.durationFrames > 0)
    .sort((a, b) => a.startFrame - b.startFrame || a.durationFrames - b.durationFrames);
  const merged: Array<{ startFrame: number; durationFrames: number }> = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];
    const spanEnd = span.startFrame + span.durationFrames;
    if (!last) {
      merged.push({ ...span });
      continue;
    }
    const lastEnd = last.startFrame + last.durationFrames;
    if (span.startFrame <= lastEnd) {
      last.durationFrames = Math.max(lastEnd, spanEnd) - last.startFrame;
    } else {
      merged.push({ ...span });
    }
  }

  return merged;
}

function retimeTimelineAfterRemovingSpans(
  assembled: AssembledTimeline,
  spans: Array<{ startFrame: number; durationFrames: number }>,
): void {
  if (spans.length === 0) return;
  const tracks = [...assembled.tracks.video, ...assembled.tracks.audio];
  for (const track of tracks) {
    const kept: TimelineClip[] = [];
    for (const clip of track.clips) {
      const start = clip.timeline_in_frame;
      const end = clip.timeline_in_frame + clip.timeline_duration_frames;
      const nextStart = retimeFrameAfterRemovingSpans(start, spans);
      const nextEnd = retimeFrameAfterRemovingSpans(end, spans);
      const nextDuration = nextEnd - nextStart;
      if (nextDuration <= 0) continue;
      clip.timeline_in_frame = nextStart;
      clip.timeline_duration_frames = nextDuration;
      kept.push(clip);
    }
    if (kept.length !== track.clips.length) {
      track.clips.splice(0, track.clips.length, ...kept);
    }
  }

  for (const marker of assembled.markers) {
    marker.frame = retimeFrameAfterRemovingSpans(marker.frame, spans);
  }
}

function retimeFrameAfterRemovingSpans(
  frame: number,
  spans: Array<{ startFrame: number; durationFrames: number }>,
): number {
  let removedFrames = 0;
  for (const span of spans) {
    const spanEnd = span.startFrame + span.durationFrames;
    if (frame >= spanEnd) {
      removedFrames += span.durationFrames;
    } else if (frame > span.startFrame) {
      removedFrames += frame - span.startFrame;
    }
  }
  return frame - removedFrames;
}

export function compile(opts: CompileOptions): CompileResult {
  const projectPath = path.resolve(opts.projectPath);
  const repoRoot = opts.repoRoot
    ? path.resolve(opts.repoRoot)
    : findRepoRoot(projectPath);

  // ── Read input artifacts ──────────────────────────────────────────

  const briefPath = path.join(projectPath, "01_intent/creative_brief.yaml");
  const blueprintPath = path.join(projectPath, "04_plan/edit_blueprint.yaml");
  const selectsPath = path.join(projectPath, "04_plan/selects_candidates.yaml");
  const defaultsPath = path.join(repoRoot, "runtime/compiler-defaults.yaml");

  const brief = readYaml<CreativeBrief>(briefPath);
  const blueprint = opts.blueprintOverride ?? readYaml<EditBlueprint>(blueprintPath);
  const selects = readYaml<SelectsCandidates>(selectsPath);
  materializePeakSignalsFromSegments(projectPath, selects);
  const defaults = readYaml<CompilerDefaults>(defaultsPath);

  // ── Phase 0.5: Resolve Duration Policy ──────────────────────────
  // Compute material total duration for guide+no-target case.
  const materialTotalSec = selects.candidates
    .filter((c) => c.role !== "reject")
    .reduce((sum, c) => sum + (c.src_out_us - c.src_in_us) / 1_000_000, 0);

  const durationPolicy = resolveDurationPolicyFromBlueprint(
    blueprint,
    brief,
    materialTotalSec,
  );
  const audioPolicy = resolveAudioPolicy(brief, blueprint, repoRoot);
  const captionPolicy = resolveCaptionPolicy(brief, blueprint, repoRoot);
  const trackLayout = blueprint.track_layout ?? "single";

  // ── Phase 1: Normalize ────────────────────────────────────────────

  const normalized = normalize(brief, blueprint);

  // ── Phase 1.5: Skill Activation ──────────────────────────────────
  // Determine which editing skills are active based on blueprint + candidates.
  // Fail-open: if no active_editing_skills in blueprint, use empty set (no skill effects).

  const activeSkills = blueprint.active_editing_skills
    ? activateSkills(blueprint, selects.candidates, selects.editorial_summary)
    : [];

  // ── Phase 2: Score ────────────────────────────────────────────────

  // Use fps from compile options if provided, otherwise default to 24fps.
  // For source material at 30fps, pass fpsNum: 30 via compile options.
  const fpsNum = opts.fpsNum ?? 24;
  const fpsDen = 1;
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const bgmDurationUs = resolveBgmDurationUs(opts, blueprint);
  const maxDurationFrames = bgmDurationUs
    ? Math.floor(bgmDurationUs / usPerFrame)
    : undefined;

  // Load BGM analysis for beat-synchronized scoring and snap decisions.
  // Canonical path is 03_analysis/bgm_analysis.json; the loader keeps a legacy fallback.
  const bgmAnalysis = loadBgmAnalysisFromProject(projectPath);
  let bgmScoringContext: BgmScoringContext | undefined;
  if (bgmAnalysis) {
    bgmScoringContext = {
      downbeats_sec: bgmAnalysis.downbeats_sec,
      sections: bgmAnalysis.sections,
      beats: bgmAnalysis.beats,
      fpsNum,
    };
  }

  const rankedTable = scoreCandidates(
    normalized,
    selects.candidates,
    defaults.scoring,
    fpsNum,
    fpsDen,
    activeSkills,
    durationPolicy,
    bgmScoringContext,
  );

  // ── Phase 2.5: Resolve Timeline Order & Output Dimensions ────────
  const timelineOrder = resolveTimelineOrder(blueprint, blueprint.resolved_profile?.id, brief);
  const sourceAssetIds = new Set(
    selects.candidates
      .map((candidate) => candidate.asset_id)
      .filter((assetId): assetId is string => typeof assetId === "string" && assetId.length > 0),
  );
  const sourceDimensions = readSourceVideoDimensions(projectPath, sourceAssetIds);
  const outputDims = resolveOutputDimensions(brief.editorial, sourceDimensions);
  const montageOrdering = isMontageOrderingBrief(brief);

  // ── Phase 3: Assemble ─────────────────────────────────────────────

  const assembled = assemble(normalized, rankedTable, defaults.scoring, fpsNum, fpsDen, durationPolicy, {
    timelineOrder,
    beatOrder: normalized.beats.map((beat) => beat.beat_id),
    trackLayout,
    audioPolicy: audioPolicy.mode,
    a1Loudnorm: audioPolicy.a1_loudnorm,
    clusterContinuity: !montageOrdering,
    bgmAssetId: blueprint.music_policy.bgm_asset_id,
    bgmSegmentId: blueprint.music_policy.bgm_segment_id,
    bgmDurationSec: blueprint.music_policy.bgm_duration_sec,
    maxDurationFrames,
    log: opts.log,
  });
  const visualCache: CompileVisualCache | null = loadVisualCache(
    projectPath,
    assembled.tracks.video.flatMap((track) => track.clips.map((clip) => clip.segment_id)),
    opts.log,
  );
  if (!montageOrdering && visualCache) {
    reorderAssembledSceneContinuity(assembled, normalized.beats, visualCache);
  }

  // ── Phase 3.5: Adaptive Trim ────────────────────────────────────
  // Apply center-based trim when trim_hint is available.
  // Falls back to authored range when no hints exist.

  const allAssembledClips = [
    ...assembled.tracks.video.flatMap((t) => t.clips),
    ...assembled.tracks.audio.flatMap((t) => t.clips),
  ];
  const visualAssembledClips = assembled.tracks.video.flatMap((t) => t.clips);
  const marlinEvents = loadProjectMarlinEvents(projectPath);
  const clipTrimPlans = marlinEvents
    ? planClipTrims(
        candidatesForAssembledClips(selects.candidates, allAssembledClips),
        loadProjectSegments(projectPath),
        marlinEvents,
        brief,
        buildBeatCraftMap(normalized.beats),
        buildClipTrimPlanningContext(normalized.beats, visualAssembledClips, usPerFrame),
      ).filter(isMarlinEventClipTrimPlan)
    : [];
  applyClipTrimPlansToCandidates(selects.candidates, clipTrimPlans);
  applyAdaptiveTrim(allAssembledClips, selects.candidates, blueprint, normalized.beats, usPerFrame, clipTrimPlans);
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (v1Track) {
    compactTrimmedClipsWithinBeats(v1Track.clips, normalized.beats, assembled.markers);
  }

  // ── Phase 3.5b: Duration Adjustment (strict mode) ───────────────
  applyDurationAdjust(assembled, normalized.beats, selects.candidates, durationPolicy, fpsNum, fpsDen);

  // ── Phase 3.5c: Utterance-boundary snap (talking_head_pacing) ───
  // When a snapping skill is active and the project has transcripts, move clip
  // in/out onto the nearest utterance edge so dialogue cuts land on phrase
  // boundaries (review metric audio.speech_cut). Runs after duration adjust so
  // it sees the final clip set; resolve (Phase 4) then sanitizes any overlap.
  // No-op for projects without transcripts or when no snap skill is active —
  // which keeps every non-talking-head golden byte-identical.
  const snapConfig = getUtteranceSnapConfig(activeSkills);
  if (snapConfig) {
    const utteranceMap = loadProjectUtterances(projectPath);
    if (utteranceMap.size > 0) {
      const snapClips = [
        ...assembled.tracks.video.flatMap((t) => t.clips),
        ...assembled.tracks.audio.flatMap((t) => t.clips),
      ];
      applyUtteranceSnap(snapClips, utteranceMap, snapConfig.toleranceUs, snapConfig.metadataTags);
    }
  }

  enforceDurationCapAfterTimingAdjustments(assembled, maxDurationFrames, opts.log);
  dropUnintentionalMicroClips(assembled, {
    beats: normalized.beats,
    log: opts.log,
  });
  if (durationPolicy.mode === "guide" && trackLayout === "single") {
    compactGuideSingleTrackGaps(assembled, normalized.beats);
  }

  // ── Phase 4: Resolve constraints ──────────────────────────────────

  const resolution = resolve(assembled, normalized.total_duration_frames, selects.candidates, durationPolicy, fpsNum, fpsDen);

  // ── Phase 4.5: Adjacency Decide ──────────────────────────────────
  // Analyze adjacent clip pairs on V1 and assign transition skills.
  // Only runs when active editing skills are available.

  let adjacencyTransitions: import("./transition-types.js").TimelineTransition[] = [];

  if (
    (activeSkills.length > 0 || hasCraftTransitions(normalized.beats) || (visualCache?.embeddings.size ?? 0) > 0) &&
    assembled.tracks.video.length > 0
  ) {
    const v1Track = assembled.tracks.video[0];
    if (v1Track.clips.length > 1) {
      const adjResult = adjacencyDecide(v1Track, {
        activeEditingSkills: activeSkills,
        durationMode: durationPolicy?.mode ?? "guide",
        fpsNum,
        bgmAnalysis,
        captionPolicySource: blueprint.caption_policy?.source,
        candidates: selects.candidates,
        beats: normalized.beats,
        visualEmbeddings: visualCache?.embeddings,
        transitionSkillsDir: opts.repoRoot
          ? path.join(opts.repoRoot, "runtime/editorial/transition-skills")
          : undefined,
      });

      adjacencyTransitions = adjResult.transitions;

      // ── Phase 4.5b: Apply beat snap to clip geometry ──────────────
      // Walk transitions and apply pair-preserving reallocation for snapped cuts.
      // This updates actual clip timeline_in_frame / timeline_duration_frames / src_in/out_us.
      const clipMap = new Map<string, import("./types.js").TimelineClip>();
      for (const clip of v1Track.clips) {
        clipMap.set(clip.clip_id, clip);
      }

      for (const tr of adjacencyTransitions) {
        const snapDelta = tr.transition_params?.snap_delta_frames;
        if (snapDelta && snapDelta !== 0) {
          const left = clipMap.get(tr.from_clip_id);
          const right = clipMap.get(tr.to_clip_id);
          if (left && right) {
            const committed = applyBeatSnap(left, right, snapDelta, fpsNum, MIN_RENDERABLE_FRAMES);
            if (!committed) {
              // Snap failed guard — revert to original cut frame
              if (tr.transition_params) {
                tr.transition_params.cut_frame_after_snap = tr.transition_params.cut_frame_before_snap;
                tr.transition_params.snap_delta_frames = 0;
                tr.transition_params.beat_snapped = false;
              }
            }
          }
        }
      }

      const finalMicroClipGuard = dropUnintentionalMicroClips(assembled, {
        beats: normalized.beats,
        log: opts.log,
      });
      if (finalMicroClipGuard.droppedClipIds.length > 0) {
        const droppedClipIds = new Set(finalMicroClipGuard.droppedClipIds);
        adjacencyTransitions = adjacencyTransitions.filter(
          (transition) =>
            !droppedClipIds.has(transition.from_clip_id) &&
            !droppedClipIds.has(transition.to_clip_id),
        );
      }
      if (durationPolicy.mode === "guide" && trackLayout === "single") {
        compactGuideSingleTrackGaps(assembled, normalized.beats);
      } else {
        syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
      }
      refreshTransitionCutFrames(adjacencyTransitions, assembled);

      // Set project_id on analysis
      adjResult.analysis.project_id = normalized.project_id;

      // Write adjacency analysis artifact
      writeAdjacencyAnalysis(adjResult.analysis, projectPath);
    }
  }

  // ── Phase 5: Export ───────────────────────────────────────────────

  const createdAt = opts.createdAt;

  let timelineIR = buildTimelineIR(assembled, {
    projectId: normalized.project_id,
    projectTitle: normalized.project_title,
    projectPath,
    createdAt,
    briefRelPath: "01_intent/creative_brief.yaml",
    blueprintRelPath: "04_plan/edit_blueprint.yaml",
    selectsRelPath: "04_plan/selects_candidates.yaml",
    fpsNum,
    fpsDen,
    durationPolicy,
    audioPolicy,
    captionPolicy,
    transitions: adjacencyTransitions.length > 0 ? adjacencyTransitions : undefined,
    width: outputDims.width,
    height: outputDims.height,
    outputAspectRatio: outputDims.output_aspect_ratio,
    letterboxPolicy: outputDims.letterbox_policy,
  });

  attachAutoCaptions(timelineIR, {
    brief,
    blueprint,
    candidates: selects.candidates,
    projectPath,
    repoRoot,
    fpsNum,
    fpsDen,
  }, captionPolicy);

  // ── Phase 5.5: Editorial Metadata ─────────────────────────────────
  // Attach skill metadata and provenance hashes when active skills exist.

  if (activeSkills.length > 0) {
    // Add provenance hashes
    timelineIR.provenance.editorial_registry_hash = computeRegistryHash();

    // Attach editorial metadata to clips
    for (const trackGroup of [timelineIR.tracks.video, timelineIR.tracks.audio]) {
      for (const track of trackGroup) {
        for (const clip of track.clips) {
          // Find matching candidate for metadata tags
          const matchingCandidate = selects.candidates.find(
            (c) => c.segment_id === clip.segment_id &&
              c.src_in_us === clip.src_in_us &&
              c.src_out_us === clip.src_out_us,
          ) ?? selects.candidates.find((c) => c.segment_id === clip.segment_id);

          if (matchingCandidate) {
            const tags = getSkillMetadataTags(activeSkills, matchingCandidate);
            if (tags.length > 0) {
              if (!clip.metadata) clip.metadata = {};
              (clip.metadata as Record<string, unknown>).editorial = {
                applied_skills: activeSkills,
                skill_tags: tags,
                resolved_profile: blueprint.resolved_profile?.id,
                resolved_policy: blueprint.resolved_policy?.id,
              };
            }
          }
        }
      }
    }
  }

  for (const trackGroup of [timelineIR.tracks.video, timelineIR.tracks.audio]) {
    for (const track of trackGroup) {
      for (const clip of track.clips) {
        const matchingCandidate = selects.candidates.find(
          (c) => c.segment_id === clip.segment_id &&
            c.src_in_us === clip.src_in_us &&
            c.src_out_us === clip.src_out_us,
        ) ?? selects.candidates.find((c) => c.segment_id === clip.segment_id);
        if (matchingCandidate?.peak_signals || matchingCandidate?.editorial_signals?.peak_strength_score != null) {
          if (!clip.metadata) clip.metadata = {};
          (clip.metadata as Record<string, unknown>).peak_signals = {
            ...(matchingCandidate.peak_signals ?? {}),
            ...(matchingCandidate.editorial_signals?.peak_strength_score != null
              ? { peak_strength_score: matchingCandidate.editorial_signals.peak_strength_score }
              : {}),
            ...(matchingCandidate.editorial_signals?.peak_type
              ? { peak_type: matchingCandidate.editorial_signals.peak_type }
              : {}),
          };
        }
      }
    }
  }

  // Add compiler defaults hash to provenance
  const defaultsHash = createHash("sha256")
    .update(JSON.stringify(defaults))
    .digest("hex")
    .slice(0, 16);
  timelineIR.provenance.compiler_defaults_hash = defaultsHash;

  let finalResolution = resolution;
  if (opts.reviewPatch) {
    const patchResult = applyPatch(
      timelineIR,
      opts.reviewPatch,
      selects.candidates,
      normalized.total_duration_frames,
      durationPolicy,
      fpsNum,
      fpsDen,
    );
    if (patchResult.errors.length > 0) {
      const details = patchResult.errors
        .map((error) => `${error.op}(${error.op_index}): ${error.message}`)
        .join("; ");
      throw new Error(`Review patch could not be applied during compile: ${details}`);
    }
    timelineIR = patchResult.timeline;
    finalResolution = patchResult.resolution;
  }

  const outputPath = writeTimeline(timelineIR, projectPath);
  const otioPath = exportOtio(timelineIR, projectPath);
  const previewManifestPath = writePreviewManifest(
    timelineIR,
    projectPath,
    loadSourceMap(projectPath, opts.sourceMapPath),
  );

  return {
    timeline: timelineIR,
    outputPath,
    otioPath,
    previewManifestPath,
    resolution: finalResolution,
    duration_policy: durationPolicy,
  };
}

function isMontageOrderingBrief(brief: CreativeBrief): boolean {
  const orderPolicy = (brief as { order_policy?: unknown }).order_policy;
  if (orderPolicy === "montage") return true;

  const editorial = brief.editorial as ({ profile?: unknown; profile_hint?: unknown } | undefined);
  const profileValues = [editorial?.profile, editorial?.profile_hint];
  return profileValues.some((value) =>
    typeof value === "string" && value.toLowerCase().includes("montage")
  );
}

function resolveAudioPolicy(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  repoRoot: string,
): ResolvedAudioPolicy {
  if (brief.audio_policy) {
    return {
      mode: brief.audio_policy,
      source: "explicit_brief",
      a1_loudnorm: resolveA1Loudnorm(brief, blueprint, repoRoot),
    };
  }

  const profileId = blueprint.resolved_profile?.id ?? brief.editorial?.profile_hint;
  if (profileId) {
    const profile = loadProfiles(path.join(repoRoot, "runtime/editorial/profiles")).get(profileId);
    if (profile?.defaults.audio_policy) {
      return {
        mode: profile.defaults.audio_policy,
        source: "profile_default",
        a1_loudnorm: brief.a1_loudnorm ?? profile.defaults.a1_loudnorm ?? true,
      };
    }
  }

  return { mode: "ducking", source: "global_default", a1_loudnorm: brief.a1_loudnorm ?? true };
}

function resolveA1Loudnorm(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  repoRoot: string,
): boolean {
  if (typeof brief.a1_loudnorm === "boolean") return brief.a1_loudnorm;
  const profileId = blueprint.resolved_profile?.id ?? brief.editorial?.profile_hint;
  if (profileId) {
    const profile = loadProfiles(path.join(repoRoot, "runtime/editorial/profiles")).get(profileId);
    if (typeof profile?.defaults.a1_loudnorm === "boolean") return profile.defaults.a1_loudnorm;
  }
  return true;
}
