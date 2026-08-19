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
import { resolve, type DurationStatus, type ResolutionReport } from "./resolve.js";
import { buildTimelineIR, exportOtio, writePreviewManifest, writeTimeline } from "./export.js";
import { reorderAssembledSceneContinuity } from "./scene-order.js";
import { loadVisualCache, type CompileVisualCache } from "./visual-cache.js";
import { applyPatch } from "./patch.js";
import { applyEndingTreatment } from "./ending-treatment.js";
import { applyCutBreathTreatment } from "./cut-breath-treatment.js";
import { applyDialogueSemanticRepair } from "./dialogue-semantic-repair.js";
import { resolveDurationPolicyFromBlueprint, resolveOutputDimensions, resolveTimelineOrder } from "./duration-helpers.js";
import { activateSkills, computeRegistryHash, getSkillMetadataTags, getUtteranceSnapConfig } from "../editorial/skill-registry.js";
import { loadProfiles } from "../editorial/policy-resolver.js";
import {
  adjacencyDecide,
  writeAdjacencyAnalysis,
  applyBeatSnap,
  hasCraftTransitions,
  evaluateTimelineContinuity,
  resolveContinuityPolicy,
} from "./adjacency.js";
import { loadBgmAnalysisFromProject } from "../media/bgm-analyzer.js";
import { validateArtifact } from "../artifacts/loaders.js";
import {
  projectMusicToTimeline,
  validateMusicCues,
  type MusicCuesDoc,
} from "../audio/music-cues.js";
import {
  projectSfxToTimeline,
  resolveSfxCuePlan,
} from "../audio/sfx-cues.js";
import type { BgmSelectionArtifact } from "../music/selection-service.js";
import { loadSourceMap } from "../media/source-map.js";
import { extractDurationUs, runFfprobe } from "../connectors/ffprobe.js";
import { attachAutoCaptions, resolveCaptionPolicy } from "../captions/timeline-captions.js";
import { materializePeakSignalsFromSegments } from "../artifacts/peak-materialization.js";
import { resolveStillDurationPolicy, resolveStillImageHold } from "../artifacts/still-image-policy.js";
import {
  assertStillImageCandidateGrounding,
  assertStillImageSegmentGrounding,
  readValidatedStillImageFrames,
} from "../artifacts/still-image-grounding.js";
import { assertImageSequenceCandidateGrounding } from "../artifacts/image-sequence-grounding.js";
import {
  assertCandidatePlanningMediaKindsSupported,
  assertProjectPlanningMediaKindsSupported,
  readAuthoritativeAssetMediaCapabilities,
} from "../artifacts/source-media-capabilities.js";
import { resolveProfileAndPolicy } from "../editorial/policy-resolver.js";
import { assertStillImageTimelineTruthForTimeline, setStillImageHoldFrames } from "./still-image.js";
import { loadSegmentEditorialEvidence } from "../artifacts/segment-editorial-evidence.js";
import { getCandidateRef } from "./candidate-ref.js";
import {
  hasVisualProgram,
  isAuthoredProgramAudio,
  primaryContentClips,
  primarySequentialClips,
} from "./primary-content.js";
import {
  applyCutBeatQuantize,
  isSpeechProtectedBeatBoundary,
  loadBeatSyncGridFromProject,
  resolveBeatSyncConfig,
  type BeatSyncCompileMetadata,
} from "./beat-sync.js";
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
  ContinuityCompileMetadata,
  ContinuityReorderEvent,
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

function isContainedPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateMusicSelectionBinding(
  projectPath: string,
  doc: MusicCuesDoc,
): void {
  if (doc.version !== "2.0.0") return;
  if (!doc.selection_ref) {
    throw new Error("music-cues/v2 requires a hash-pinned bgm_selection reference.");
  }
  const projectRealPath = fs.realpathSync(projectPath);
  const selectionPath = path.resolve(projectRealPath, doc.selection_ref.path);
  if (!isContainedPath(projectRealPath, selectionPath) || !fs.existsSync(selectionPath)) {
    throw new Error("music-cues/v2 selection_ref is missing or resolves outside the project.");
  }
  const selectionRealPath = fs.realpathSync(selectionPath);
  if (!isContainedPath(projectRealPath, selectionRealPath)) {
    throw new Error("music-cues/v2 selection_ref resolves through a symlink outside the project.");
  }
  const selectionBytes = fs.readFileSync(selectionRealPath);
  const selectionHash = `sha256:${createHash("sha256").update(selectionBytes).digest("hex")}`;
  if (selectionHash !== doc.selection_ref.content_hash) {
    throw new Error("music-cues/v2 bgm_selection hash pin is stale.");
  }
  const selection = validateArtifact<BgmSelectionArtifact>(
    JSON.parse(selectionBytes.toString("utf8")),
    "bgm-selection.schema.json",
  );
  const pin = selection.selected_track_pin;
  const asset = doc.music_asset;
  if (
    selection.mode !== "operator_locked"
    || !selection.selected
    || !pin
    || selection.selected.track_id !== asset.track_id
    || pin.track_id !== asset.track_id
    || pin.pack_id !== asset.pack_id
    || pin.pack_version !== asset.pack_version
    || pin.pack_manifest_hash !== asset.pack_manifest_hash
    || selection.selected.content_hash !== asset.full_mix_content_hash
    || asset.source_hash !== asset.full_mix_content_hash
    || pin.full_mix_content_hash !== asset.full_mix_content_hash
    || pin.full_mix_size_bytes !== asset.full_mix_size_bytes
    || pin.full_mix_path !== asset.path
    || pin.analysis_content_hash !== asset.analysis_content_hash
    || pin.analysis_size_bytes !== asset.analysis_size_bytes
    || pin.analysis_path !== asset.analysis_ref
    || pin.analysis_status !== asset.analysis_status
  ) {
    throw new Error("music-cues/v2 Pack, track, full-mix, or analysis pins do not match bgm_selection.");
  }
}

/**
 * Compiler-owned music projection. Missing cues are a strict no-op. Legacy
 * cues stay readable, but an original_only project is unchanged unless a v2
 * operator_locked selection explicitly authorizes the candidate cue.
 */
export function projectProjectMusicCues(
  timeline: TimelineIR,
  projectPath: string,
  audioPolicy: BriefAudioPolicy,
  fpsNum: number,
  fpsDen: number,
): TimelineIR {
  const cuesPath = path.join(projectPath, "07_package", "music_cues.json");
  if (!fs.existsSync(cuesPath)) return timeline;
  const doc = validateArtifact<MusicCuesDoc>(
    JSON.parse(fs.readFileSync(cuesPath, "utf8")),
    "music-cues.schema.json",
  );
  const validation = validateMusicCues(doc);
  if (!validation.valid) {
    throw new Error(`Invalid music_cues: ${validation.errors.join("; ")}`);
  }
  if (audioPolicy === "original_only" && doc.version !== "2.0.0") return timeline;
  if (doc.project_id !== timeline.project_id) {
    throw new Error("music_cues project_id does not match the compiled timeline.");
  }
  if (doc.base_timeline_version !== timeline.version) {
    throw new Error("music_cues base_timeline_version is stale.");
  }
  validateMusicSelectionBinding(projectPath, doc);
  return projectMusicToTimeline(timeline, doc, { fpsNum, fpsDen }) as TimelineIR;
}

/**
 * Compiler-owned SFX projection. An absent artifact is a strict no-op.
 * original_only remains byte-compatible and never activates A3 SFX.
 */
export function projectProjectSfxCues(
  timeline: TimelineIR,
  projectPath: string,
  audioPolicy: BriefAudioPolicy,
  fpsNum: number,
  fpsDen: number,
): TimelineIR {
  const cuesPath = path.join(projectPath, "07_package", "sfx_cues.json");
  if (!fs.existsSync(cuesPath) || audioPolicy === "original_only") {
    return timeline;
  }
  if (
    timeline.sequence.fps_num !== fpsNum
    || timeline.sequence.fps_den !== fpsDen
  ) {
    throw new Error("SFX projection fps arguments do not match the timeline.");
  }
  const plan = resolveSfxCuePlan({
    projectDir: projectPath,
    timeline,
    cuesPath,
  });
  return projectSfxToTimeline(timeline, plan);
}

export function isEditorialEyeRelationV1Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ENABLE_EDITORIAL_EYE_RELATION_V1?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

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
  continuity: ContinuityCompileMetadata;
  beat_sync?: BeatSyncCompileMetadata;
}

export class ContinuityConstraintError extends Error {
  readonly continuity: ContinuityCompileMetadata;

  constructor(continuity: ContinuityCompileMetadata) {
    super(formatContinuityConstraintError(continuity));
    this.name = "ContinuityConstraintError";
    this.continuity = continuity;
  }
}

function formatContinuityConstraintError(continuity: ContinuityCompileMetadata): string {
  const details = continuity.errors
    .map((issue) => {
      const runs = issue.runs
        .map((run) => `${run.clip_ids.join(",")}@${run.beat_ids.join("+")}`)
        .join(" | ");
      return `${issue.message} ${issue.suggested_fix} Runs: ${runs}`;
    })
    .join("; ");
  return `Compile blocked by continuity constraints: ${details}`;
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

export interface ResolvedUtteranceSnapConfig {
  toleranceUs: number;
  metadataTags: string[];
  preferNextOutBoundary?: boolean;
  updateTimelineDuration?: boolean;
  constrainToBeatDurations?: boolean;
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
    let parsed: {
      asset_id?: string;
      items?: Array<{
        start_us?: number;
        end_us?: number;
        text?: string;
        speaker?: string;
      }>;
    };
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
        spans.push({
          start_us: item.start_us,
          end_us: item.end_us,
          ...(typeof item.text === "string" && item.text.trim()
            ? { text: item.text.trim() }
            : {}),
          ...(typeof item.speaker === "string" && item.speaker.trim()
            ? { speaker: item.speaker.trim() }
            : {}),
        });
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
      map.set(assetId, spans);
    }
  }
  return map;
}

export function resolveUtteranceSnapConfig(
  activeSkills: string[],
  blueprint: EditBlueprint,
  selects: SelectsCandidates,
): ResolvedUtteranceSnapConfig | null {
  const skillConfig = getUtteranceSnapConfig(activeSkills);
  if (skillConfig) return skillConfig;

  if (
    blueprint.dialogue_policy?.preserve_natural_breath === true &&
    selects.editorial_summary?.dominant_visual_mode === "talking_head"
  ) {
    return {
      toleranceUs: 15_000_000,
      metadataTags: ["preserve_natural_breath_boundary_snapped"],
      preferNextOutBoundary: true,
      updateTimelineDuration: true,
      constrainToBeatDurations: true,
    };
  }

  return null;
}

function buildUtteranceSnapDurationTargets(
  beats: NormalizedBeat[],
  usPerFrame: number,
): Map<string, number> {
  const targets = new Map<string, number>();
  for (const beat of beats) {
    if (beat.target_duration_frames > 0) {
      targets.set(beat.beat_id, beat.target_duration_frames * usPerFrame);
    }
  }
  return targets;
}

function buildUtteranceSnapMaxDurations(
  blueprint: EditBlueprint,
  beats: NormalizedBeat[],
  usPerFrame: number,
): Map<string, number> {
  const maxFrames = blueprint.pacing?.max_shot_length_frames ??
    blueprint.trim_policy?.default_max_duration_frames;
  const maxDurations = new Map<string, number>();
  if (!maxFrames || maxFrames <= 0) return maxDurations;
  for (const beat of beats) {
    maxDurations.set(beat.beat_id, maxFrames * usPerFrame);
  }
  return maxDurations;
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

function applyExactCandidatePlanRevisitExemptions(
  beats: NormalizedBeat[],
  candidates: Candidate[],
): void {
  const candidatesByRef = new Map<string, Candidate>();
  for (const candidate of candidates) {
    candidatesByRef.set(getCandidateRef(candidate), candidate);
    if (!candidatesByRef.has(candidate.segment_id)) {
      candidatesByRef.set(candidate.segment_id, candidate);
    }
  }

  const assetUseCounts = new Map<string, number>();
  const clusterUseCounts = new Map<string, number>();
  for (const beat of beats) {
    const refs = [
      beat.candidate_plan?.primary_candidate_ref,
      ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
    ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    const repeatedCandidates: Candidate[] = [];
    for (const ref of refs) {
      const candidate = candidatesByRef.get(ref);
      if (!candidate) continue;
      const clusterId = candidate.editorial_signals?.semantic_cluster_id?.trim();
      const repeatedAsset = (assetUseCounts.get(candidate.asset_id) ?? 0) > 0;
      const repeatedCluster = clusterId
        ? (clusterUseCounts.get(clusterId) ?? 0) > 0
        : false;
      if (repeatedAsset || repeatedCluster) repeatedCandidates.push(candidate);
      assetUseCounts.set(candidate.asset_id, (assetUseCounts.get(candidate.asset_id) ?? 0) + 1);
      if (clusterId) {
        clusterUseCounts.set(clusterId, (clusterUseCounts.get(clusterId) ?? 0) + 1);
      }
    }
    if (repeatedCandidates.length === 0 || beat.allow_revisit === true) continue;

    const existing = typeof beat.allow_revisit === "object" ? beat.allow_revisit : undefined;
    const assetIds = new Set(existing?.asset_ids ?? []);
    const semanticClusterIds = new Set(existing?.semantic_cluster_ids ?? []);
    for (const candidate of repeatedCandidates) {
      assetIds.add(candidate.asset_id);
      const clusterId = candidate.editorial_signals?.semantic_cluster_id?.trim();
      if (clusterId) semanticClusterIds.add(clusterId);
    }
    beat.allow_revisit = {
      ...(assetIds.size > 0 ? { asset_ids: [...assetIds].sort() } : {}),
      ...(semanticClusterIds.size > 0
        ? { semantic_cluster_ids: [...semanticClusterIds].sort() }
        : {}),
      reason: existing?.reason ?? "explicit candidate_plan reprise under human_golden_order",
    };
  }
}

function assertExactCandidatePlanAgreement(
  blueprint: EditBlueprint,
  candidates: Candidate[],
  assembled: AssembledTimeline,
  resolution: CompileResult["resolution"],
): void {
  const candidatesByRef = new Map<string, Candidate>();
  for (const candidate of candidates) {
    candidatesByRef.set(getCandidateRef(candidate), candidate);
    if (!candidatesByRef.has(candidate.segment_id)) {
      candidatesByRef.set(candidate.segment_id, candidate);
    }
  }
  const canonicalRef = (ref: string): string => {
    const candidate = candidatesByRef.get(ref);
    return candidate ? getCandidateRef(candidate) : `missing:${ref}`;
  };

  const expectedPlacements = blueprint.beats.flatMap((beat, beatIndex) => [
    beat.candidate_plan?.primary_candidate_ref,
    ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
  ]
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
    .map((ref, planIndex) => ({ ref: canonicalRef(ref), beatId: beat.id, beatIndex, planIndex })));
  const expected = expectedPlacements.map((placement) => placement.ref);
  const placementOrder = new Map(expectedPlacements.map((placement, index) =>
    [`${placement.beatId}:${placement.ref}`, index]
  ));
  const actual = [
    ...assembled.tracks.video.flatMap((track) => track.clips),
    ...assembled.tracks.audio.flatMap((track) => track.clips).filter(isAuthoredProgramAudio),
  ].sort((left, right) => {
    const leftRef = canonicalRef(left.candidate_ref ?? left.segment_id);
    const rightRef = canonicalRef(right.candidate_ref ?? right.segment_id);
    return (placementOrder.get(`${left.beat_id}:${leftRef}`) ?? Number.MAX_SAFE_INTEGER) -
      (placementOrder.get(`${right.beat_id}:${rightRef}`) ?? Number.MAX_SAFE_INTEGER) ||
      left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id);
  }).map((clip) => {
    if (clip.candidate_ref) return canonicalRef(clip.candidate_ref);
    return canonicalRef(clip.segment_id);
  });

  const orderMatches = expected.length === actual.length &&
    expected.every((ref, index) => ref === actual[index]);
  if (!orderMatches) {
    throw new Error(
      `human_golden_order constraint failed: candidate_plan expected ${expected.length} placements but compiled ${actual.length}, or their authored order changed.`,
    );
  }

  const tolerance = blueprint.quality_targets?.duration_pacing_tolerance_pct;
  const durationDeltaPct = Math.abs(resolution.duration_delta_pct ?? 0);
  if (typeof tolerance === "number" && durationDeltaPct > tolerance) {
    throw new Error(
      `human_golden_order constraint failed: duration drift ${durationDeltaPct}% exceeds ${tolerance}% tolerance.`,
    );
  }
}

export function compactGuideSingleTrackGaps(
  assembled: AssembledTimeline,
  beats: NormalizedBeat[] = [],
): void {
  const primaryClips = primarySequentialClips(assembled);
  if (primaryClips.length <= 1) {
    syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
    alignBeatMarkersToPrimaryTrack(assembled, beats);
    alignAuthoredAudioToBeatMarkers(assembled);
    return;
  }

  const ordered = [...primaryClips].sort(compareTimelineClips);
  let cursor = 0;
  for (const clip of ordered) {
    clip.timeline_in_frame = cursor;
    cursor += Math.max(0, clip.timeline_duration_frames);
  }
  if (hasVisualProgram(assembled)) {
    const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1") ?? assembled.tracks.video[0];
    v1Track?.clips.splice(0, v1Track.clips.length, ...ordered);
  }

  syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
  alignBeatMarkersToPrimaryTrack(assembled, beats);
  alignAuthoredAudioToBeatMarkers(assembled);
}

function alignAuthoredAudioToBeatMarkers(assembled: AssembledTimeline): void {
  if (!hasVisualProgram(assembled)) return;
  const markerByBeat = new Map(assembled.markers
    .filter((marker) => marker.kind === "beat")
    .map((marker) => [marker.label.split(":")[0]?.trim(), marker.frame]));
  for (const track of assembled.tracks.audio) {
    const cursorByBeat = new Map<string, number>();
    for (const clip of track.clips.filter(isAuthoredProgramAudio).sort(compareTimelineClips)) {
      const start = cursorByBeat.get(clip.beat_id) ?? markerByBeat.get(clip.beat_id);
      if (start === undefined) continue;
      clip.timeline_in_frame = start;
      cursorByBeat.set(clip.beat_id, start + clip.timeline_duration_frames);
    }
    track.clips.sort(compareTimelineClips);
  }
}

function compareTimelineClips(left: TimelineClip, right: TimelineClip): number {
  return left.timeline_in_frame - right.timeline_in_frame ||
    left.clip_id.localeCompare(right.clip_id);
}

function syncGeneratedAudioMirrorsWithPrimaryVideo(assembled: AssembledTimeline): void {
  const videoQueues = new Map<string, TimelineClip[]>();
  for (const track of assembled.tracks.video) {
    for (const clip of track.clips) {
      for (const key of audioMirrorMatchKeys(clip)) {
        const queue = videoQueues.get(key) ?? [];
        queue.push(clip);
        videoQueues.set(key, queue);
      }
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

export function removeOverlappingGeneratedAudioMirrors(assembled: AssembledTimeline): string[] {
  const primaryAudioClips = assembled.tracks.audio
    .flatMap((track) => track.clips)
    .filter(isPrimaryProgramAudio);
  if (primaryAudioClips.length === 0) return [];

  const droppedClipIds: string[] = [];
  for (const track of assembled.tracks.audio) {
    const kept = track.clips.filter((clip) => {
      const shouldDrop = isGeneratedAudioMirror(clip) &&
        primaryAudioClips.some((primary) => primary.clip_id !== clip.clip_id && timelineRangesOverlap(clip, primary));
      if (shouldDrop) droppedClipIds.push(clip.clip_id);
      return !shouldDrop;
    });
    if (kept.length !== track.clips.length) {
      track.clips.splice(0, track.clips.length, ...kept);
    }
  }

  return droppedClipIds;
}

export function selectUtteranceSnapClips(assembled: AssembledTimeline): TimelineClip[] {
  const audioClips = assembled.tracks.audio.flatMap((track) => track.clips);
  if (!hasVisualProgram(assembled)) return audioClips.filter(isAuthoredProgramAudio);
  const audioSourceKeys = new Set(audioClips.map((clip) => sourceRangeKey(clip)));
  const syncedVideoClips = assembled.tracks.video
    .flatMap((track) => track.clips)
    .filter((clip) => audioSourceKeys.has(sourceRangeKey(clip)));

  return [...syncedVideoClips, ...audioClips];
}

function isPrimaryProgramAudio(clip: TimelineClip): boolean {
  if (isGeneratedAudioMirror(clip)) return false;
  return clip.role !== "bgm" && clip.role !== "music";
}

function alignBeatMarkersToPrimaryTrack(
  assembled: AssembledTimeline,
  beats: NormalizedBeat[] = [],
): void {
  const primaryClips = primarySequentialClips(assembled);
  if (primaryClips.length === 0) return;

  const beatIds = new Set(beats.map((beat) => beat.beat_id));
  const firstFrameByBeat = new Map<string, number>();
  for (const clip of [...primaryClips].sort(compareTimelineClips)) {
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
    if (!plan || !clipTrimPlanOverlapsCandidate(plan, candidate)) continue;

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

function clipTrimPlanOverlapsCandidate(plan: ClipTrimPlan, candidate: Candidate): boolean {
  return plan.best_in_us < candidate.src_out_us && candidate.src_in_us < plan.best_out_us;
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
    preserveAuthoredCandidatePlan?: boolean;
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
  const visualProgram = hasVisualProgram(assembled);
  const primaryClips = primarySequentialClips(assembled);
  if (primaryClips.length === 0) return result;

  const beatCraftById = new Map(
    (options.beats ?? []).map((beat) => [beat.beat_id, beat.craft]),
  );
  const droppedV1Clips: TimelineClip[] = [];
  for (const clip of primaryClips) {
    if (clip.timeline_duration_frames >= minRenderableFrames) continue;
    if (options.preserveAuthoredCandidatePlan && clip.candidate_ref) {
      annotateAuthoredShortClip(clip);
      continue;
    }
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

  for (const track of visualProgram ? assembled.tracks.video : assembled.tracks.audio) {
    track.clips.splice(
      0,
      track.clips.length,
      ...track.clips.filter((clip) => !droppedClipIds.has(clip.clip_id)),
    );
  }

  for (const track of assembled.tracks.audio) {
    const kept = track.clips.filter((clip) => {
      const shouldDrop = visualProgram && isGeneratedAudioMirror(clip) && droppedMirrorKeys.has(audioMirrorKey(clip));
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
  emit(
    `[compile] dropped ${result.dropped} micro-clip(s) below minimum renderable duration: ${result.droppedClipIds.join(", ")}`,
  );
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

function annotateAuthoredShortClip(clip: TimelineClip): void {
  const metadata = recordValue(clip.metadata) ?? {};
  const editorial = recordValue(metadata.editorial) ?? {};
  editorial.intentional_short_clip = true;
  editorial.reason = "human_golden_order";
  metadata.editorial = editorial;
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

function timelineRangesOverlap(left: TimelineClip, right: TimelineClip): boolean {
  const leftStart = left.timeline_in_frame;
  const leftEnd = left.timeline_in_frame + left.timeline_duration_frames;
  const rightStart = right.timeline_in_frame;
  const rightEnd = right.timeline_in_frame + right.timeline_duration_frames;
  return leftStart < rightEnd && rightStart < leftEnd;
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
      if (clip.media_kind === "image" && clip.still_image && nextDuration < clip.still_image.min_hold_frames) continue;
      clip.timeline_in_frame = nextStart;
      setStillImageHoldFrames(clip, nextDuration, clip.media_kind === "image" ? "duration_cap" : "none");
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
  assertProjectPlanningMediaKindsSupported(projectPath);
  assertStillImageSegmentGrounding(projectPath);
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
  const authoritativeCapabilities = readAuthoritativeAssetMediaCapabilities(projectPath);
  const groundedStillFrames = readValidatedStillImageFrames(projectPath);
  for (const candidate of selects.candidates) {
    const capability = authoritativeCapabilities.get(candidate.asset_id);
    if (capability) {
      candidate.media_kind = capability.media_kind;
      candidate.source_capabilities = { ...capability.source_capabilities };
    }
    if (groundedStillFrames.has(candidate.asset_id)) {
      candidate.media_kind = "image";
      candidate.source_capabilities = { has_video: true, has_audio: false };
    }
  }
  assertCandidatePlanningMediaKindsSupported(selects.candidates);
  assertStillImageCandidateGrounding(projectPath, selects.candidates);
  assertImageSequenceCandidateGrounding(projectPath, selects.candidates);
  materializePeakSignalsFromSegments(projectPath, selects);
  const defaults = readYaml<CompilerDefaults>(defaultsPath);
  const continuityPolicy = resolveContinuityPolicy(defaults.continuity);
  const beatSyncConfig = resolveBeatSyncConfig(defaults);
  const continuityReorders: ContinuityReorderEvent[] = [];

  const fpsNum = opts.fpsNum ?? 24;
  const fpsDen = opts.fpsDen ?? 1;
  const hasImageCandidates = selects.candidates.some((candidate) => candidate.media_kind === "image");
  const profileResolution = hasImageCandidates ? resolveProfileAndPolicy({
    briefEditorial: brief.editorial,
    editorialSummary: selects.editorial_summary,
    runtimeTargetSec: brief.project.runtime_target_sec,
  }) : undefined;
  const stillDurationPolicy = !hasImageCandidates
    ? undefined
    : blueprint.still_duration_policy?.fps_num === fpsNum &&
    blueprint.still_duration_policy.fps_den === fpsDen
    ? blueprint.still_duration_policy
    : resolveStillDurationPolicy(brief, profileResolution?.profileDefaults, fpsNum, fpsDen);
  if (stillDurationPolicy) blueprint.still_duration_policy = stillDurationPolicy;

  // ── Phase 0.5: Resolve Duration Policy ──────────────────────────
  // Compute material total duration for guide+no-target case.
  const materialTotalSec = selects.candidates
    .filter((c) => c.role !== "reject")
    .reduce((sum, c) => sum + (c.media_kind === "image"
      ? resolveStillImageHold(c, stillDurationPolicy!, stillDurationPolicy!.max_hold_frames).hold_frames * fpsDen / fpsNum
      : (c.src_out_us - c.src_in_us) / 1_000_000), 0);

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
  const humanGoldenOrder = activeSkills.includes("human_golden_order");
  const exactCandidatePlanOrder = humanGoldenOrder ||
    activeSkills.includes("longform_reduction");
  if (exactCandidatePlanOrder) {
    applyExactCandidatePlanRevisitExemptions(normalized.beats, selects.candidates);
  }

  // ── Phase 2: Score ────────────────────────────────────────────────

  // Use fps from compile options if provided, otherwise default to 24fps.
  // For source material at 30fps, pass fpsNum: 30 via compile options.
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
  const beatSyncGrid = loadBeatSyncGridFromProject(projectPath, fpsNum);

  const rankedTable = scoreCandidates(
    normalized,
    selects.candidates,
    defaults.scoring,
    fpsNum,
    fpsDen,
    activeSkills,
    durationPolicy,
    bgmScoringContext,
    stillDurationPolicy,
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
    sameAssetRepeatPolicy: continuityPolicy.same_asset_repeat,
    continuityReorders,
    exactCandidatePlanOrder,
    log: opts.log,
    stillDurationPolicy,
  });
  const visualCache: CompileVisualCache | null = loadVisualCache(
    projectPath,
    assembled.tracks.video.flatMap((track) => track.clips.map((clip) => clip.segment_id)),
    opts.log,
  );
  if (!montageOrdering && !exactCandidatePlanOrder && visualCache) {
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
  const trimmableAssembledClips = allAssembledClips.filter((clip) => clip.media_kind !== "image");
  const marlinEvents = loadProjectMarlinEvents(projectPath);
  // A human golden exact plan already contains operator-authored source
  // windows. Marlin may evaluate those placements, but must not rewrite them.
  const clipTrimPlans = marlinEvents && !exactCandidatePlanOrder
    ? planClipTrims(
        candidatesForAssembledClips(selects.candidates, trimmableAssembledClips),
        loadProjectSegments(projectPath),
        marlinEvents,
        brief,
        buildBeatCraftMap(normalized.beats),
        buildClipTrimPlanningContext(normalized.beats, visualAssembledClips, usPerFrame),
      ).filter(isMarlinEventClipTrimPlan)
    : [];
  applyClipTrimPlansToCandidates(selects.candidates, clipTrimPlans);
  applyAdaptiveTrim(trimmableAssembledClips, selects.candidates, blueprint, normalized.beats, usPerFrame, clipTrimPlans);
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (v1Track) {
    compactTrimmedClipsWithinBeats(v1Track.clips, normalized.beats, assembled.markers);
  }

  // ── Phase 3.5b: Duration Adjustment (strict mode) ───────────────
  applyDurationAdjust(assembled, normalized.beats, selects.candidates, durationPolicy, fpsNum, fpsDen, stillDurationPolicy);

  // ── Phase 3.5c: Utterance-boundary snap ──────────────────────────
  // When a snapping skill is active, or a talking-head project explicitly asks
  // to preserve natural breath, move clip in/out onto clean utterance edges so
  // dialogue cuts land on phrase boundaries (review metric audio.speech_cut).
  // Runs after duration adjust so it sees the final clip set; resolve (Phase 4)
  // then sanitizes any overlap. No-op for projects without transcripts or
  // non-talking-head projects without an active snap skill.
  const snapConfig = resolveUtteranceSnapConfig(activeSkills, blueprint, selects);
  if (snapConfig) {
    const utteranceMap = loadProjectUtterances(projectPath);
    if (utteranceMap.size > 0) {
      const snapClips = selectUtteranceSnapClips(assembled);
      const targetDurationUsByBeat = snapConfig.constrainToBeatDurations
        ? buildUtteranceSnapDurationTargets(normalized.beats, usPerFrame)
        : undefined;
      const maxDurationUsByBeat = snapConfig.constrainToBeatDurations
        ? buildUtteranceSnapMaxDurations(blueprint, normalized.beats, usPerFrame)
        : undefined;
      applyUtteranceSnap(snapClips, utteranceMap, snapConfig.toleranceUs, snapConfig.metadataTags, {
        preferNextOutBoundary: snapConfig.preferNextOutBoundary,
        updateTimelineDuration: snapConfig.updateTimelineDuration,
        usPerFrame,
        targetDurationUsByBeat,
        maxDurationUsByBeat,
      });
      if (!humanGoldenOrder) {
        const semanticRepair = applyDialogueSemanticRepair(
          assembled,
          utteranceMap,
          loadProjectSegments(projectPath),
          fpsNum / fpsDen,
        );
        if (semanticRepair.attemptedClips > 0) {
          const emit = opts.log ?? console.warn;
          emit(
            `[dialogue-semantic-repair] attempted=${semanticRepair.attemptedClips} ` +
            `repaired=${semanticRepair.repairedClips} unresolved=${semanticRepair.unresolvedClips} ` +
            `added_frames=${semanticRepair.totalAddedFrames}`,
          );
        }
      }
    }
  }

  enforceDurationCapAfterTimingAdjustments(assembled, maxDurationFrames, opts.log);
  dropUnintentionalMicroClips(assembled, {
    beats: normalized.beats,
    preserveAuthoredCandidatePlan: exactCandidatePlanOrder,
    log: opts.log,
  });
  if (durationPolicy.mode === "guide" && trackLayout === "single") {
    compactGuideSingleTrackGaps(assembled, normalized.beats);
  }

  // ── Phase 4: Resolve constraints ──────────────────────────────────

  const resolution = resolve(assembled, normalized.total_duration_frames, selects.candidates, durationPolicy, fpsNum, fpsDen);
  if (exactCandidatePlanOrder) {
    assertExactCandidatePlanAgreement(blueprint, selects.candidates, assembled, resolution);
  }

  // ── Phase 4.5: Adjacency Decide ──────────────────────────────────
  // Analyze adjacent clip pairs on V1 and assign transition skills.
  // Only runs when active editing skills are available.

  let adjacencyTransitions: import("./transition-types.js").TimelineTransition[] = [];
  const segmentEvidenceIndex = isEditorialEyeRelationV1Enabled()
    ? loadSegmentEditorialEvidence(projectPath, opts.log ?? console.warn)
    : undefined;

  const shouldAnalyzeTransitions =
    activeSkills.length > 0 ||
    hasCraftTransitions(normalized.beats) ||
    Boolean(blueprint.transition_policy) ||
    (visualCache?.embeddings.size ?? 0) > 0 ||
    segmentEvidenceIndex !== undefined;

  if (shouldAnalyzeTransitions && assembled.tracks.video.length > 0) {
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
        segmentEvidenceIndex,
        visualEmbeddings: visualCache && visualCache.embeddings.size > 0
          ? visualCache.embeddings
          : undefined,
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
            const committed = left.media_kind === "image" || right.media_kind === "image" ||
              isSpeechProtectedBeatBoundary(left, right)
              ? false
              : applyBeatSnap(left, right, snapDelta, fpsNum, MIN_RENDERABLE_FRAMES);
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
        preserveAuthoredCandidatePlan: exactCandidatePlanOrder,
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
  removeOverlappingGeneratedAudioMirrors(assembled);

  const beatSyncMinDurationFrames = Math.max(
    MIN_RENDERABLE_FRAMES,
    Math.floor(blueprint.trim_policy?.default_min_duration_frames ?? 0),
  );
  const beatSyncMetadata = applyCutBeatQuantize(assembled, {
    mode: beatSyncConfig.mode,
    grid: beatSyncGrid,
    fpsNum,
    maxShiftFrames: beatSyncConfig.maxShiftFrames,
    minDurationFrames: beatSyncMinDurationFrames,
  });
  if (beatSyncMetadata?.enabled && beatSyncMetadata.counts.quantized > 0) {
    syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
    removeOverlappingGeneratedAudioMirrors(assembled);
    refreshTransitionCutFrames(adjacencyTransitions, assembled);
  }

  const continuity = evaluateTimelineContinuity(assembled.tracks.video, {
    candidates: selects.candidates,
    beats: normalized.beats,
    policy: continuityPolicy,
    reorders: continuityReorders,
  });
  if (continuity.errors.length > 0) {
    throw new ContinuityConstraintError(continuity);
  }

  // ── Phase 5: Export ───────────────────────────────────────────────

  assertStillImageTimelineTruthForTimeline(assembled);

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
    stillDurationPolicy,
    transitions: adjacencyTransitions.length > 0 ? adjacencyTransitions : undefined,
    width: outputDims.width,
    height: outputDims.height,
    outputAspectRatio: outputDims.output_aspect_ratio,
    letterboxPolicy: outputDims.letterbox_policy,
    metadata: {
      continuity,
      ...(beatSyncMetadata ? { beat_sync: beatSyncMetadata } : {}),
    },
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
              const metadata = clip.metadata as Record<string, unknown>;
              const existingEditorial = recordValue(metadata.editorial) ?? {};
              metadata.editorial = {
                ...existingEditorial,
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

  const cutBreathTreatment = applyCutBreathTreatment(
    timelineIR,
    blueprint.dialogue_policy,
    loadProjectSegments(projectPath),
    loadProjectUtterances(projectPath),
    fpsNum / fpsDen,
  );
  if (cutBreathTreatment.totalExtendedFrames > 0) {
    finalResolution = extendResolutionForEnding(
      finalResolution,
      cutBreathTreatment.totalExtendedFrames,
    );
  }

  const endingTreatment = applyEndingTreatment(
    timelineIR,
    blueprint.ending_policy,
    loadProjectSegments(projectPath),
    fpsNum / fpsDen,
    loadProjectUtterances(projectPath),
  );
  if (endingTreatment.extendedFrames > 0) {
    finalResolution = extendResolutionForEnding(
      finalResolution,
      endingTreatment.extendedFrames,
    );
  }

  timelineIR = projectProjectMusicCues(
    timelineIR,
    projectPath,
    audioPolicy.mode,
    fpsNum,
    fpsDen,
  );
  timelineIR = projectProjectSfxCues(
    timelineIR,
    projectPath,
    audioPolicy.mode,
    fpsNum,
    fpsDen,
  );

  assertStillImageTimelineTruthForTimeline(timelineIR);

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
    continuity,
    ...(beatSyncMetadata ? { beat_sync: beatSyncMetadata } : {}),
  };
}

function extendResolutionForEnding(
  resolution: ResolutionReport,
  extendedFrames: number,
): ResolutionReport {
  const totalFrames = resolution.total_frames + extendedFrames;
  const contentFrames = (resolution.content_frames ?? resolution.total_frames) + extendedFrames;
  const minFrames = resolution.min_target_frames ?? resolution.target_frames;
  const maxFrames = resolution.max_target_frames;
  const isGuide = resolution.duration_mode === "guide";
  const durationFit = isGuide
    ? maxFrames == null || totalFrames <= maxFrames
    : totalFrames >= minFrames && totalFrames <= (maxFrames ?? resolution.target_frames);
  const isShort = contentFrames / Math.max(1, resolution.target_frames) < 0.8 ||
    contentFrames < minFrames;
  const isOver = maxFrames != null
    ? totalFrames > maxFrames || contentFrames > maxFrames
    : !isGuide && totalFrames > resolution.target_frames;
  const durationStatus: DurationStatus = isShort ? "short" : isOver ? "over" : "pass";

  return {
    ...resolution,
    duration_fit: durationFit,
    total_frames: totalFrames,
    ...(resolution.duration_status !== undefined ? { duration_status: durationStatus } : {}),
    duration_delta_frames: contentFrames - resolution.target_frames,
    duration_delta_pct: resolution.target_frames > 0
      ? ((contentFrames - resolution.target_frames) / resolution.target_frames) * 100
      : 0,
    content_frames: contentFrames,
    content_fill_ratio: resolution.target_frames > 0
      ? contentFrames / resolution.target_frames
      : 1,
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
