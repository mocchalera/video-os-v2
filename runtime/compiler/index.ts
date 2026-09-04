// Timeline Compiler — Main entry point
// Orchestrates Phase 1-5 to produce timeline.json from project artifacts.
// Pure, deterministic. No LLM calls. No randomness.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../commands/shared.js";
import { validateProject } from "../validation/schema-validator.js";
import { reconcileCompiledTimelineState } from "../state/reconcile.js";
import { loadSourceMap } from "../media/source-map.js";
import {
  buildDerivedMappingReceipt,
  buildReviewEditIdentityReceipt,
  computeArtifactSha256,
  stampReviewDerivation,
} from "../review/edit-identity.js";
import { normalize } from "./normalize.js";
import { scoreCandidates } from "./score.js";
import { assemble } from "./assemble.js";
import {
  applyAdaptiveTrim,
  applyUtteranceSnap,
  compactTrimmedClipsWithinBeats,
  type TrimRangeReport,
  type UtteranceSpan,
} from "./trim.js";
import { applyDurationAdjust } from "./duration-adjust.js";
import {
  resolve,
  resolveCoverageHorizon,
  type DurationStatus,
  type ResolutionReport,
} from "./resolve.js";
import { buildTimelineIR, exportOtio } from "./export.js";
import {
  finalizeCompileArtifactsAtomically,
  type AtomicCompileFinalizeResult,
} from "./atomic-finalize.js";
import { reorderAssembledSceneContinuity } from "./scene-order.js";
import { loadVisualCache, type CompileVisualCache } from "./visual-cache.js";
import { applyPatch, type ReviewPatch } from "./patch.js";
import { applyEndingTreatment } from "./ending-treatment.js";
import { applyCutBreathTreatment } from "./cut-breath-treatment.js";
import { applyDialogueSemanticRepair } from "./dialogue-semantic-repair.js";
import { resolveDurationPolicyFromBlueprint, resolveOutputDimensions, resolveTimelineOrder } from "./duration-helpers.js";
import {
  activateSkills,
  computeRegistryHash,
  getApexFreezeHoldConfig,
  getSkillMetadataTags,
  getUtteranceSnapConfig,
} from "../editorial/skill-registry.js";
import { loadProfiles } from "../editorial/policy-resolver.js";
import {
  adjacencyDecide,
  writeAdjacencyAnalysis,
  applyBeatSnap,
  hasCraftTransitions,
  evaluateTimelineContinuity,
  resolveContinuityPolicy,
} from "./adjacency.js";
import { applyTransitionOverlaps } from "./transition-overlap.js";
import { loadBlueprint, loadBlueprintData, validateArtifact } from "../artifacts/loaders.js";
import {
  projectMusicToTimeline,
  validateMusicCues,
  type MusicCuesDoc,
} from "../audio/music-cues.js";
import {
  projectSfxToTimeline,
  resolveSfxCuePlan,
  type ResolvedSfxCuePlan,
} from "../audio/sfx-cues.js";
import type { BgmSelectionArtifact } from "../music/selection-service.js";
import { extractDurationUs, runFfprobe } from "../connectors/ffprobe.js";
import { attachAutoCaptions, resolveCaptionPolicy } from "../captions/timeline-captions.js";
import { materializePeakSignalsFromSegments } from "../artifacts/peak-materialization.js";
import {
  buildStillHoldResolutionContext,
  resolveStillDurationPolicy,
  resolveStillImageHold,
} from "../artifacts/still-image-policy.js";
import { buildLyricMvTimelineMetadata } from "./lyric-mv.js";
import {
  assertStillImageCandidateGrounding,
  assertStillImageSegmentGrounding,
  readValidatedStillImageFrames,
} from "../artifacts/still-image-grounding.js";
import { assertImageSequenceCandidateGrounding } from "../artifacts/image-sequence-grounding.js";
import {
  assertCandidatePlanningMediaKindsSupported,
  candidateSupportsVisual,
  assertProjectPlanningMediaKindsSupported,
  readAuthoritativeAssetMediaCapabilities,
} from "../artifacts/source-media-capabilities.js";
import { resolveProfileAndPolicy } from "../editorial/policy-resolver.js";
import { assertStillImageTimelineTruthForTimeline, setStillImageHoldFrames } from "./still-image.js";
import { assertImageQcGateOpen, imageQcAppliesToProject, ImageQcGateError,
  type ImageQcReport, runImageQcGate } from "../artifacts/image-qc-report.js";
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
  applyRhythmSyncSnaps,
  buildRhythmEventGridFromSnapshot,
  loadRhythmEvidenceSnapshot,
  loadSourceDurationsFromProject,
  recomputeAndEnforceRhythmSync,
  resolveRhythmSyncConfig,
  type RhythmSyncCompileMetadata,
} from "./rhythm-sync.js";
import { hasM2BgmProvenance } from "../media/bgm-analysis-contract.js";
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
import { synchronizeSameSourceTalkCuts } from "./av-sync.js";
import { resolveCreatorShortVoBrollPreset } from "./creator-short-vo-broll.js";
import { applyApexFreezeHolds, materializeCandidatePlanFreezeHolds } from "./apex-freeze-hold.js";
import { framingPolicyContentHash, loadFramingPolicy } from "../visual/framing-policy.js";
import { projectRegisteredVisualIntents } from "../visual/jump-cut-policy.js";
import { verifyReframeCandidateEvidence, type ReframeCandidateEvidence } from "../visual/reframe.js";
import { loadVerticalCompositionPolicy, resolveVerticalComposition, verticalCompositionPolicyContentHash } from "../visual/vertical-composition.js";
import { loadRetentionPolicy, retentionPolicyContentHash } from "../editorial/short-form-retention.js";
import {
  assertHookRecompileAllowed,
  buildHookLockProvenance,
} from "./hook-lock.js";
import {
  bindShotAnchorsToTimeline,
  computeHookFingerprint,
  resolveShotAnchors,
  type ShotAnchorSourceIdentity,
} from "./shot-anchor-resolver.js";
import {
  evaluateNormalizedNarrativeArcContract,
  NarrativeArcContractError,
} from "../eval/narrative-arc-contract.js";
import {
  GapFreeTimelineError,
  InsufficientContentError,
  PrimaryAudioGapError,
  TimelineOperationError,
} from "./errors.js";
import {
  assertRenderSourceReadiness,
  buildRenderSourceReadiness,
  type FormalSfxSourceAuthority,
  type RenderSourceReadinessReport,
} from "./render-readiness.js";
import {
  buildBeatAllocationReport,
  type BeatAllocationReport,
} from "./diagnostics.js";
import {
  findPrimaryAudioGaps,
  findPrimaryVideoGaps,
  primaryVideoEndFrame,
  validateIntentionalGapOperation,
  validatePrimaryAudioMixPolicy,
} from "./coverage.js";
import type {
  Candidate,
  CompileOptions,
  CompilerDefaults,
  ContinuityCompileMetadata,
  ContinuityReorderEvent,
  CreativeBrief,
  CreativeBriefMusicMaster,
  AssembledTimeline,
  BriefAudioPolicy,
  CraftDirective,
  DurationPolicy,
  EditBlueprint,
  IntentionalGapOperation,
  NormalizedBeat,
  SelectsCandidates,
  TimelineClip,
  TimelineIR,
  CompileArtifactReceipt,
  CompilePromotionContext,
  TrimHint,
} from "./types.js";

export type { TimelineIR, CompileOptions, CompileArtifactReceipt, CompilePromotionContext };
export { GapFreeTimelineError, InsufficientContentError, PrimaryAudioGapError, RhythmParityGateError, TimelineOperationError } from "./errors.js";
export {
  assertRenderSourceReadiness,
  buildRenderSourceReadiness,
  computeSourceMappingHash,
  evaluateSourceMappingContract,
  RenderSourceUnresolvedError,
} from "./render-readiness.js";
export type {
  FormalSfxSourceAuthority,
  RenderSourceReadinessReport,
  RenderSourceResolution,
  SourceMappingContractStatus,
} from "./render-readiness.js";
export { AtomicArtifactValidationError } from "./atomic-finalize.js";
export { applyPatch } from "./patch.js";
export type { ReviewPatch, PatchResult, PatchError, PatchOperation } from "./patch.js";
export type { ResolutionReport } from "./resolve.js";
export {
  buildBeatAllocationReport,
  classifyRemedy,
  formatBeatAllocationReport,
  suggestRecoveryGate,
} from "./diagnostics.js";
export type {
  BeatAllocationReport,
  BeatAllocationEntry,
  BeatAllocationGap,
  RecoverySuggestion,
  RemedyClass,
} from "./diagnostics.js";
export {
  findPrimaryAudioGaps,
  primaryAudioTrack,
  validatePrimaryAudioMixPolicy,
} from "./coverage.js";
export type { PrimaryAudioMixPolicy } from "./types.js";

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
  if (audioPolicy === "music_master" || !fs.existsSync(cuesPath)) return timeline;
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
function resolveProjectSfxCuePlan(
  timeline: TimelineIR,
  projectPath: string,
  audioPolicy: BriefAudioPolicy,
  fpsNum: number,
  fpsDen: number,
  repoSfxRoot?: string,
): ResolvedSfxCuePlan | undefined {
  const cuesPath = path.join(projectPath, "07_package", "sfx_cues.json");
  if (!fs.existsSync(cuesPath) || audioPolicy === "original_only" || audioPolicy === "music_master") {
    return undefined;
  }
  if (
    timeline.sequence.fps_num !== fpsNum
    || timeline.sequence.fps_den !== fpsDen
  ) {
    throw new Error("SFX projection fps arguments do not match the timeline.");
  }
  const plan = resolveSfxCuePlan({
    projectDir: projectPath,
    ...(repoSfxRoot ? { repoSfxRoot } : {}),
    timeline,
    cuesPath,
  });
  return plan;
}

function buildFormalSfxSourceAuthorities(
  plan: ResolvedSfxCuePlan,
  projectPath: string,
  repoSfxRoot?: string,
): ReadonlyMap<string, FormalSfxSourceAuthority> {
  const libraryScope = plan.library.scope;
  if (!libraryScope) {
    throw new Error("Formal SFX cue plan requires an explicit library scope.");
  }
  const authorityRoot = libraryScope === "repo_common"
    ? repoSfxRoot
    : projectPath;
  if (!authorityRoot) {
    throw new Error("Formal repo-common SFX requires an explicit repoSfxRoot.");
  }
  return new Map(plan.cues.map((cue) => [
    `A3_${cue.cue_id}`,
    {
      cue_id: cue.cue_id,
      asset_id: cue.asset_id,
      semantic_role: cue.semantic_role,
      source_path: cue.source_path,
      expected_sha256: cue.asset_pin.asset_content_hash,
      authority_root: path.resolve(authorityRoot),
      sfx_asset: {
        asset_id: cue.asset_id,
        source_path: cue.source_path,
        library_id: plan.library.library_id,
        library_version: plan.library.library_version,
        library_manifest_hash: plan.library.manifest_hash,
        library_scope: libraryScope,
        asset_content_hash: cue.asset_pin.asset_content_hash,
      },
    },
  ]));
}

export function projectProjectSfxCues(
  timeline: TimelineIR,
  projectPath: string,
  audioPolicy: BriefAudioPolicy,
  fpsNum: number,
  fpsDen: number,
  repoSfxRoot?: string,
): TimelineIR {
  const plan = resolveProjectSfxCuePlan(
    timeline,
    projectPath,
    audioPolicy,
    fpsNum,
    fpsDen,
    repoSfxRoot,
  );
  return plan ? projectSfxToTimeline(timeline, plan) : timeline;
}

/**
 * Compiler-owned audio contract projection. This is metadata-only: the
 * compiler records the semantic lane owners and source pins after A2/A3
 * projection, but never moves a picture, dialogue, or caption frame to fit
 * an audio operation.
 */
export function projectProjectAudioPolicy(
  timeline: TimelineIR,
  audioPolicy: Pick<ResolvedAudioPolicy, "mode" | "a1_loudnorm"> & {
    source?: "explicit_brief" | "profile_default" | "global_default";
    audio_decision?: "preserve" | "mastering";
    music_master?: CreativeBriefMusicMaster;
  },
  sourceMap?: ReturnType<typeof loadSourceMap>,
  sourceHashByAssetId?: ReadonlyMap<string, string>,
): TimelineIR {
  const sourceRefs = timeline.tracks.audio.flatMap((track) => {
    if (track.track_id !== "A1" && track.track_id !== "A2" && track.track_id !== "A3") return [];
    return track.clips.map((clip) => {
      const metadata = clip.metadata ?? {};
      const sourceEntry = sourceMap?.entryMap.get(clip.asset_id);
      const musicAsset = metadata.music_asset;
      const sfxAsset = metadata.sfx_asset;
      const sourceRef = [metadata.source_ref, metadata.source_locator, metadata.source_path, sourceEntry?.source_locator]
        .find((value): value is string => typeof value === "string" && value.length > 0);
      const sourceContentHash = [
        metadata.source_content_hash,
        metadata.content_hash,
        typeof musicAsset === "object" && musicAsset !== null && !Array.isArray(musicAsset)
          ? (musicAsset as Record<string, unknown>).full_mix_content_hash
          : undefined,
        typeof sfxAsset === "object" && sfxAsset !== null && !Array.isArray(sfxAsset)
          ? (sfxAsset as Record<string, unknown>).asset_content_hash
          : undefined,
        sourceEntry?.source_content_sha256,
        sourceHashByAssetId?.get(clip.asset_id),
      ].map(canonicalAudioProjectionHash)
        .find((value): value is string => value !== undefined);
      return {
        track_id: track.track_id as "A1" | "A2" | "A3",
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
        ...(sourceRef ? { source_ref: sourceRef } : {}),
        ...(sourceContentHash ? { source_content_hash: sourceContentHash } : {}),
      };
    });
  });
  const projection = {
    version: "audio-render-projection/v1" as const,
    lane_semantics: {
      A1: "dialogue_and_natural_sound" as const,
      A2: "music_bgm" as const,
      A3: "texture_ambient_and_sfx" as const,
    },
    dialogue_authority: "A1" as const,
    conflict_policy: "dialogue_first" as const,
    picture_dialogue_caption_timing_immutable: true as const,
    audio_displacement_frames: 0 as const,
    source_refs: sourceRefs,
  };
  return {
    ...timeline,
    metadata: {
      ...(timeline.metadata ?? {}),
      audio_render_projection: {
        ...projection,
        audio_policy_mode: audioPolicy.mode,
        audio_policy_source: audioPolicy.source ?? "global_default",
        a1_loudnorm: audioPolicy.a1_loudnorm,
      },
    },
    provenance: {
      ...timeline.provenance,
      ...(audioPolicy.mode === "music_master" && audioPolicy.music_master
        ? {
            audio_policy: {
              ...(timeline.provenance.audio_policy ?? {}),
              mode: "music_master" as const,
              source: audioPolicy.source ?? "global_default",
              ...(audioPolicy.a1_loudnorm !== undefined
                ? { a1_loudnorm: audioPolicy.a1_loudnorm }
                : {}),
              audio_decision: audioPolicy.audio_decision ?? "preserve",
              music_master: structuredClone(audioPolicy.music_master),
            },
          }
        : {}),
      audio_render_projection: projection,
    },
  };
}

function canonicalAudioProjectionHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value;
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  return undefined;
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
    gap_details?: import("./coverage.js").PrimaryVideoGap[];
    audio_gap_frames?: number;
    audio_gap_count?: number;
    audio_gap_details?: import("./coverage.js").PrimaryAudioGap[];
    beat_fill?: Array<{ beat_id: string; target: number; actual: number; fill_ratio: number }>;
  };
  duration_policy?: DurationPolicy;
  continuity: ContinuityCompileMetadata;
  beat_sync?: BeatSyncCompileMetadata;
  rhythm_sync?: RhythmSyncCompileMetadata;
  trim_range_report?: TrimRangeReport[];
  render_readiness?: RenderSourceReadinessReport;
  beat_allocation_report?: BeatAllocationReport;
  artifact_receipts?: CompileArtifactReceipt[];
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
  audio_decision?: "preserve" | "mastering";
  music_master?: CreativeBriefMusicMaster;
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
 * Pure projection of the compile-entry transcript snapshot: utterance spans
 * per asset. Deterministic (files sorted, spans sorted). Empty spans are
 * skipped exactly like the legacy directory-scanning reader; the snapshot
 * itself guarantees each file was read exactly once at compile entry, so no
 * consumer re-opens transcript paths (Issue #35 A→B→A protection).
 */
function utterancesFromTranscriptSnapshot(
  transcripts: import("./rhythm-sync.js").TranscriptsDirSnapshot,
): Map<string, UtteranceSpan[]> {
  const map = new Map<string, UtteranceSpan[]>();
  for (const file of transcripts.files) {
    // Issue #35 project binding: only transcripts whose snapshotted doc
    // carried project_id exactly equal to the current project ("bound") may
    // affect geometry. Missing, foreign, malformed or mixed-in foreign files
    // are recorded as degraded provenance and contribute NOTHING.
    if (file.binding !== "bound") continue;
    const parsed = file.doc as {
      asset_id?: string;
      items?: Array<{
        start_us?: number;
        end_us?: number;
        text?: string;
        speaker?: string;
      }>;
    } | undefined;
    const assetId = parsed?.asset_id;
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

function readExistingTimeline(projectPath: string): TimelineIR | undefined {
  const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
  if (!fs.existsSync(timelinePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineIR;
  } catch (error) {
    throw new Error(
      `Cannot inspect the existing canonical timeline for Hook lock enforcement: ${timelinePath}`,
      { cause: error },
    );
  }
}

function loadShotAnchorSourceIdentities(
  projectPath: string,
  sourceMap: ReturnType<typeof loadSourceMap>,
): Map<string, ShotAnchorSourceIdentity> {
  const identities = new Map<string, ShotAnchorSourceIdentity>();
  for (const entry of sourceMap.entries) {
    if (typeof entry.source_content_sha256 !== "string") continue;
    identities.set(entry.asset_id, {
      asset_id: entry.asset_id,
      source_content_hash: entry.source_content_sha256,
      ...(entry.source_fingerprint ? { source_fingerprint: entry.source_fingerprint } : {}),
      evidence_source: "source_map",
    });
  }

  const assets = readJsonIfExists<{
    items?: Array<{
      asset_id?: unknown;
      source_content_sha256?: unknown;
      source_content_hash?: unknown;
      source_fingerprint?: unknown;
    }>;
  }>(path.join(projectPath, "03_analysis", "assets.json"));
  for (const asset of assets?.items ?? []) {
    if (typeof asset.asset_id !== "string" || identities.has(asset.asset_id)) continue;
    const sourceHash = typeof asset.source_content_sha256 === "string"
      ? asset.source_content_sha256
      : typeof asset.source_content_hash === "string"
        ? asset.source_content_hash
        : undefined;
    if (!sourceHash) continue;
    identities.set(asset.asset_id, {
      asset_id: asset.asset_id,
      source_content_hash: sourceHash,
      ...(typeof asset.source_fingerprint === "string"
        ? { source_fingerprint: asset.source_fingerprint }
        : {}),
      evidence_source: "assets",
    });
  }
  return identities;
}

function resolveFramingPolicyArtifact(
  projectPath: string,
  blueprint: EditBlueprint,
): { policy: ReturnType<typeof loadFramingPolicy>; relativePath: string; contentHash: string } {
  const reference = blueprint.policy_refs?.composition_policy_ref;
  if (!reference) {
    throw new Error("visual_intents require policy_refs.composition_policy_ref pointing to framing_policy.json");
  }
  const policyPath = path.resolve(projectPath, reference.ref);
  if (!isContainedPath(projectPath, policyPath) || !fs.existsSync(policyPath)) {
    throw new Error(`composition_policy_ref is missing or outside the project: ${reference.ref}`);
  }
  const realPolicyPath = fs.realpathSync(policyPath);
  if (!isContainedPath(fs.realpathSync(projectPath), realPolicyPath)) {
    throw new Error(`composition_policy_ref resolves through a symlink outside the project: ${reference.ref}`);
  }
  if (reference.source_hash) {
    const actualHash = `sha256:${createHash("sha256").update(fs.readFileSync(realPolicyPath)).digest("hex")}`;
    if (actualHash !== reference.source_hash) {
      throw new Error(`composition_policy_ref source hash is stale: ${reference.ref}`);
    }
  }
  const policy = loadFramingPolicy(realPolicyPath);
  if (reference.version && reference.version !== policy.version) {
    throw new Error(`composition_policy_ref version mismatch: expected ${reference.version}, found ${policy.version}`);
  }
  return {
    policy,
    relativePath: path.relative(projectPath, realPolicyPath).split(path.sep).join("/"),
    contentHash: framingPolicyContentHash(policy),
  };
}

function resolveVerticalCompositionPolicyArtifact(
  projectPath: string,
  reference: { ref: string; version?: string; source_hash?: string },
): { policy: ReturnType<typeof loadVerticalCompositionPolicy>; relativePath: string; contentHash: string } {
  const policyPath = path.resolve(projectPath, reference.ref);
  if (!isContainedPath(projectPath, policyPath) || !fs.existsSync(policyPath)) {
    throw new Error(`vertical_composition_policy_ref is missing or outside the project: ${reference.ref}`);
  }
  const realPolicyPath = fs.realpathSync(policyPath);
  if (!isContainedPath(fs.realpathSync(projectPath), realPolicyPath)) {
    throw new Error(`vertical_composition_policy_ref resolves through a symlink outside the project: ${reference.ref}`);
  }
  if (reference.source_hash) {
    const actualHash = `sha256:${createHash("sha256").update(fs.readFileSync(realPolicyPath)).digest("hex")}`;
    if (actualHash !== reference.source_hash) throw new Error(`vertical_composition_policy_ref source hash is stale: ${reference.ref}`);
  }
  const policy = loadVerticalCompositionPolicy(realPolicyPath);
  if (reference.version && reference.version !== policy.version) throw new Error(`vertical_composition_policy_ref version mismatch: expected ${reference.version}, found ${policy.version}`);
  return { policy, relativePath: path.relative(projectPath, realPolicyPath).split(path.sep).join("/"), contentHash: verticalCompositionPolicyContentHash(policy) };
}

function resolveRetentionPolicyArtifact(
  projectPath: string,
  reference: { ref: string; version?: string; source_hash?: string },
): { policy: ReturnType<typeof loadRetentionPolicy>; relativePath: string; contentHash: string } {
  const policyPath = path.resolve(projectPath, reference.ref);
  if (!isContainedPath(projectPath, policyPath) || !fs.existsSync(policyPath)) {
    throw new Error(`retention_policy_ref is missing or outside the project: ${reference.ref}`);
  }
  const realPolicyPath = fs.realpathSync(policyPath);
  if (!isContainedPath(fs.realpathSync(projectPath), realPolicyPath)) {
    throw new Error(`retention_policy_ref resolves through a symlink outside the project: ${reference.ref}`);
  }
  if (reference.source_hash) {
    const actualHash = `sha256:${createHash("sha256").update(fs.readFileSync(realPolicyPath)).digest("hex")}`;
    if (actualHash !== reference.source_hash) throw new Error(`retention_policy_ref source hash is stale: ${reference.ref}`);
  }
  const policy = loadRetentionPolicy(realPolicyPath);
  if (reference.version && reference.version !== policy.version) throw new Error(`retention_policy_ref version mismatch: expected ${reference.version}, found ${policy.version}`);
  return { policy, relativePath: path.relative(projectPath, realPolicyPath).split(path.sep).join("/"), contentHash: retentionPolicyContentHash(policy) };
}

function resolveReframeCandidateArtifacts(
  projectPath: string,
  intents: EditBlueprint["visual_intents"],
  framingPolicyHash: string,
): Map<string, ReframeCandidateEvidence> {
  const candidates = new Map<string, ReframeCandidateEvidence>();
  for (const intent of intents ?? []) {
    const reference = intent.reframe_candidate_ref;
    const expectedHash = intent.reframe_candidate_hash;
    if (reference === undefined && expectedHash === undefined) continue;
    if (typeof reference !== "string" || !reference.trim() || typeof expectedHash !== "string" || !expectedHash.trim()) {
      throw new Error(`${intent.intent_id}: reframe_candidate_ref and reframe_candidate_hash are required together`);
    }
    const candidatePath = path.resolve(projectPath, reference);
    if (!isContainedPath(projectPath, candidatePath) || !fs.existsSync(candidatePath)) {
      throw new Error(`${intent.intent_id}: reframe candidate artifact is missing or outside the project: ${reference}`);
    }
    const realCandidatePath = fs.realpathSync(candidatePath);
    if (!isContainedPath(fs.realpathSync(projectPath), realCandidatePath)) {
      throw new Error(`${intent.intent_id}: reframe candidate artifact resolves through a symlink outside the project: ${reference}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(realCandidatePath, "utf-8"));
    } catch (error) {
      throw new Error(`${intent.intent_id}: cannot parse reframe candidate artifact ${reference}`, { cause: error });
    }
    let candidate: ReframeCandidateEvidence;
    try {
      candidate = verifyReframeCandidateEvidence(raw as ReframeCandidateEvidence);
    } catch (error) {
      throw new Error(`${intent.intent_id}: reframe candidate artifact verification failed: ${error instanceof Error ? error.message : "unknown evidence error"}`);
    }
    if (candidate.candidate_hash !== expectedHash) {
      throw new Error(`${intent.intent_id}: reframe candidate hash does not match Blueprint adoption pin: ${reference}`);
    }
    if (candidate.framing_policy.content_hash !== framingPolicyHash) {
      throw new Error(`${intent.intent_id}: reframe candidate framing policy content hash does not match the loaded framing_policy.json`);
    }
    const existing = candidates.get(reference);
    if (existing && existing.candidate_hash !== candidate.candidate_hash) {
      throw new Error(`${intent.intent_id}: reframe candidate reference is reused with conflicting evidence: ${reference}`);
    }
    candidates.set(reference, candidate);
  }
  return candidates;
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

/**
 * Lyric MV still reuse is an authored instance contract, not a broad continuity
 * waiver. Only a repeated source still explicitly marked intentional receives
 * an allow_revisit directive; an unmarked duplicate remains a continuity error.
 */
export function applyIntentionalStillReuseExemptions(
  beats: NormalizedBeat[],
  candidates: Candidate[],
): void {
  const candidatesByRef = new Map<string, Candidate>();
  for (const candidate of candidates) {
    candidatesByRef.set(getCandidateRef(candidate), candidate);
    if (!candidatesByRef.has(candidate.segment_id)) candidatesByRef.set(candidate.segment_id, candidate);
  }
  const seenAssets = new Set<string>();
  for (const beat of beats) {
    const refs = [
      beat.candidate_plan?.primary_candidate_ref,
      ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
    ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    const intentionalAssets = new Set<string>();
    for (const ref of refs) {
      const candidate = candidatesByRef.get(ref);
      if (!candidate || candidate.media_kind !== "image") continue;
      const planIntent = beat.candidate_plan?.primary_candidate_ref === ref
        ? beat.candidate_plan.still_image
        : undefined;
      const intent = { ...(candidate.still_image ?? {}), ...(planIntent ?? {}) };
      if (intent.reuse === "intentional" && seenAssets.has(candidate.asset_id)) {
        intentionalAssets.add(candidate.asset_id);
      }
    }
    if (intentionalAssets.size === 0) {
      for (const ref of refs) {
        const candidate = candidatesByRef.get(ref);
        if (candidate?.media_kind === "image") seenAssets.add(candidate.asset_id);
      }
      continue;
    }
    const existing = typeof beat.allow_revisit === "object" ? beat.allow_revisit : undefined;
    const assetIds = new Set(existing?.asset_ids ?? []);
    for (const assetId of intentionalAssets) assetIds.add(assetId);
    beat.allow_revisit = {
      ...(assetIds.size > 0 ? { asset_ids: [...assetIds].sort() } : {}),
      ...(existing?.semantic_cluster_ids ? { semantic_cluster_ids: [...existing.semantic_cluster_ids] } : {}),
      reason: existing?.reason ?? "lyric_mv intentional still instance reuse",
    };
    for (const ref of refs) {
      const candidate = candidatesByRef.get(ref);
      if (candidate?.media_kind === "image") seenAssets.add(candidate.asset_id);
    }
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

function readSourceAvGeometry(
  projectPath: string,
  assetIds: Set<string>,
): { video: { width: number; height: number; fps_num: number; fps_den: number }; audio: { sample_rate: number; channels: number } } | undefined {
  if (assetIds.size === 0) return undefined;
  const assetsPath = path.join(projectPath, "03_analysis/assets.json");
  if (!fs.existsSync(assetsPath)) return undefined;

  try {
    const assetsDoc = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
      items?: Array<{
        asset_id?: string;
        video_stream?: { width?: number; height?: number; fps_num?: number; fps_den?: number };
        audio_stream?: { sample_rate?: number; channels?: number };
      }>;
    };
    const items = (assetsDoc.items ?? []).filter((item) => typeof item.asset_id === "string" && assetIds.has(item.asset_id));
    if (items.length !== assetIds.size) return undefined;
    const geometries = items.map((item) => ({
      video: {
        width: item.video_stream?.width ?? 0,
        height: item.video_stream?.height ?? 0,
        fps_num: item.video_stream?.fps_num ?? 0,
        fps_den: item.video_stream?.fps_den ?? 0,
      },
      audio: {
        sample_rate: item.audio_stream?.sample_rate ?? 0,
        channels: item.audio_stream?.channels ?? 0,
      },
    }));
    if (geometries.some((geometry) => Object.values(geometry.video).some((value) => value <= 0) || Object.values(geometry.audio).some((value) => value <= 0))) return undefined;
    const [first, ...rest] = geometries;
    if (!first || rest.some((geometry) => JSON.stringify(geometry) !== JSON.stringify(first))) return undefined;
    return first;
  } catch {
    return undefined;
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

/** Public persisted compile route. The QC report is a canonical artifact:
 * current frame hashes and the Issue 37/44 gate are checked before mutation. */
export function compile(opts: CompileOptions): CompileResult {
  const projectPath = canonicalProjectPath(opts.projectPath);
  return runSynchronousProjectMutation(canonicalProjectMutationKey(projectPath), () => {
    if (imageQcAppliesToProject(projectPath)) {
      assertImageQcGateOpen(projectPath);
    }
    return compileCore({ ...opts, projectPath });
  });
}

/** Run the public QC route and enforce the persisted report before a patch. */
async function enforceCanonicalImageQcGateContinuation(projectPath: string) {
  const outcome = await runImageQcGate({ projectDir: path.resolve(projectPath) });
  if (outcome.applicable) assertImageQcGateOpen(projectPath);
  return outcome;
}

/** Preserve the existing public report-only API. */
export async function enforceCanonicalImageQcGate(projectPath: string): Promise<ImageQcReport> {
  const outcome = await enforceCanonicalImageQcGateContinuation(projectPath);
  return outcome.report as ImageQcReport;
}

/**
 * Shared mutation sequencer: BOTH the canonical compile route and the
 * canonical --patch route enqueue here with the same project key, so two
 * mutations of one project never interleave, a rejected predecessor never
 * poisons later callers, and the ledger entry is cleaned up when the last
 * chained sequence settles.
 */
const projectMutationSequences = new Map<string, Promise<unknown>>();
const synchronousProjectMutations = new Set<string>();

function canonicalProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
    throw error;
  }
}

function canonicalProjectMutationKey(projectPath: string): string {
  return canonicalProjectPath(projectPath);
}

function runSynchronousProjectMutation<T>(key: string, task: () => T): T {
  // A synchronous public compile cannot wait on an async queue without
  // deadlocking the event loop. It therefore shares the same ledger and fails
  // closed while an async mutation owns this project.
  if (synchronousProjectMutations.has(key) || projectMutationSequences.has(key)) {
    throw new Error(`project mutation already in progress: ${key}`);
  }
  synchronousProjectMutations.add(key);
  try {
    return task();
  } finally {
    synchronousProjectMutations.delete(key);
  }
}

function enqueueProjectMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = projectMutationSequences.get(key) ?? Promise.resolve();
  // A rejected predecessor must not poison the chain: every queued caller
  // still runs with its own options.
  const owned = previous.catch(() => undefined).then(task);
  const settledChain: Promise<unknown> = owned.finally(() => {
    if (projectMutationSequences.get(key) === settledChain) {
      projectMutationSequences.delete(key);
    }
  });
  // The ledger entry itself never produces unhandled rejections.
  settledChain.catch(() => undefined);
  projectMutationSequences.set(key, settledChain);
  return owned;
}

export function assertCompileDurationGate(input: {
  hardGate: boolean;
  resolution: CompileResult["resolution"];
}): void {
  if (!input.hardGate || input.resolution.duration_fit) return;

  const contentFrames = input.resolution.content_frames ?? input.resolution.total_frames;
  const minFrames = input.resolution.min_target_frames ?? input.resolution.target_frames;
  const maxFrames = input.resolution.max_target_frames ?? input.resolution.target_frames;
  const status = input.resolution.duration_status
    ?? (contentFrames < minFrames ? "short" : "over");

  throw new Error(
    `Hard duration gate failed: status=${status} content_frames=${contentFrames} ` +
    `allowed_frames=${minFrames}..${maxFrames} target_frames=${input.resolution.target_frames}`,
  );
}

export function assertGeneratedTimelineValid(projectPath: string, repoRoot?: string): void {
  const validation = validateProject(projectPath, repoRoot ? { repoRoot } : {});
  const timelineSchemaInvalid = validation.violations.some(
    (violation) => violation.artifact === "timeline-ir.schema.json",
  );
  if (validation.gate2_timeline_valid && !timelineSchemaInvalid) return;
  const details = validation.violations
    .filter((violation) => violation.artifact === "05_timeline/timeline.json")
    .map((violation) => `[${violation.rule}] ${violation.message}`)
    .join("; ");
  throw new Error(`Generated timeline.json has validation issues${details ? `: ${details}` : ""}`);
}

/**
 * Private patch mutation core: gate enforcement, binding re-verification,
 * and the timeline patch application/promotion. Reachable only through
 * runCanonicalPatch's sequencer slot.
 */
async function applyCanonicalPatchMutation(
  absProject: string,
  patchPath: string,
  sourceMapPath?: string,
  options: { defaultsOverride?: Partial<CompilerDefaults> } = {},
): Promise<void> {
  const absPatch = path.resolve(patchPath);
  // Validate the requested patch bytes and route before project-state checks.
  // These are stable read-only request failures and must not write a fresh QC
  // report or depend on a timeline/QC artifact that cannot be patched anyway.
  let patchRaw: string;
  try {
    patchRaw = fs.readFileSync(absPatch, "utf-8");
  } catch (error) {
    console.error(`Patch file not found: ${absPatch}`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Patch file not found: ${absPatch}`);
    }
    throw new Error(`Patch file unreadable: ${absPatch}`);
  }

  let patch: ReviewPatch;
  try {
    patch = JSON.parse(patchRaw) as ReviewPatch;
  } catch (error) {
    throw new Error(`Review patch JSON invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const patchValidation = validateAgainstSchema(patch, "review-patch.schema.json");
  if (!patchValidation.valid) throw new Error(`Review patch schema invalid: ${patchValidation.errors.join("; ")}`);
  if (patch.patch_version !== "review-patch/v2") {
    throw new Error("canonical patch route requires patch_version=review-patch/v2");
  }
  const canonicalPatchPath = path.join(absProject, "06_review", "review_patch.json");
  let patchStat: fs.Stats;
  try {
    patchStat = fs.lstatSync(absPatch);
  } catch (error) {
    throw new Error(`Review patch path invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (patchStat.isSymbolicLink() || !patchStat.isFile()) {
    throw new Error("review-patch/v2 must be the canonical 06_review/review_patch.json artifact");
  }
  let patchRealPath: string;
  try {
    patchRealPath = fs.realpathSync(absPatch);
  } catch (error) {
    throw new Error(`Review patch path invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (patchRealPath !== canonicalPatchPath) {
    throw new Error("review-patch/v2 must be the canonical 06_review/review_patch.json artifact");
  }
  if (patch.status !== "accepted") throw new Error("review-patch/v2 must have status=accepted before canonical derivation");

  const timelinePath = path.join(absProject, "05_timeline/timeline.json");

  if (!fs.existsSync(timelinePath)) {
    console.error(`Timeline not found: ${timelinePath}`);
    console.error("Run compile first before applying a patch.");
    throw new Error(`Timeline not found: ${timelinePath}`);
  }

  // Canonical fail-closed Image QC gate BEFORE any output mutation. The
  // gate re-runs the fresh orchestration; rejected, missing, unavailable,
  // stale, deleted, or replayed reports throw here and leave the timeline
  // byte-identical.
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const baseTimelineSha256 = computeArtifactSha256(timelinePath);
  if (patch.base_timeline_sha256 !== baseTimelineSha256) {
    throw new Error(`canonical timeline hash mismatch: patch=${patch.base_timeline_sha256} current=${baseTimelineSha256}`);
  }

  // Canonical fail-closed Image QC gate BEFORE any output mutation. Optional
  // provider absence is a typed Issue 44 handoff; qa_failed and required
  // capability absence remain blocked.
  await enforceCanonicalImageQcGateContinuation(absProject);
  // The gate itself may wait on a provider. Re-check the patch base as soon
  // as that wait returns, before doing any derived patch/readiness work; a
  // concurrent writer must not make this operation reason over a stale
  // timeline even if a later validation would fail for an unrelated reason.
  const timelineSha256AfterGate = computeArtifactSha256(timelinePath);
  if (timelineSha256AfterGate !== baseTimelineSha256) {
    throw new Error(`canonical timeline changed during patch: base=${baseTimelineSha256} current=${timelineSha256AfterGate}`);
  }
  if (patch.base_timeline_sha256 !== timelineSha256AfterGate) {
    throw new Error(`canonical timeline hash mismatch: patch=${patch.base_timeline_sha256} current=${timelineSha256AfterGate}`);
  }
  // Retain the exact canonical input bytes beside the derived timeline. The
  // review identity consumer re-applies the accepted patch to this snapshot,
  // so a receipt cannot make a hand-written variant appear derivable.
  const canonicalTimelineBytes = fs.readFileSync(timelinePath, "utf-8");

  const selectsPath = path.join(absProject, "04_plan/selects_candidates.yaml");
  const selectsRaw = fs.readFileSync(selectsPath, "utf-8");
  const selects = parseYaml(selectsRaw) as { candidates: Candidate[] };

  const blueprintPath = path.join(absProject, "04_plan/edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as EditBlueprint;
  const targetDurationFrames = blueprint.beats.reduce(
    (sum, b) => sum + b.target_duration_frames,
    0,
  );
  const patchDurationPolicy: DurationPolicy = blueprint.duration_policy ?? {
    mode: "guide",
    source: "global_default",
    target_source: "material_total",
    target_duration_sec: targetDurationFrames / (timeline.sequence.fps_num / timeline.sequence.fps_den),
    min_duration_sec: 0,
    max_duration_sec: null,
    hard_gate: false,
    protect_vlm_peaks: true,
  };

  const result = applyPatch(
    timeline,
    patch,
    selects.candidates,
    targetDurationFrames,
    patchDurationPolicy,
    timeline.sequence.fps_num,
    timeline.sequence.fps_den,
  );

  if (result.errors.length > 0) {
    console.error("Patch errors:");
    for (const err of result.errors) {
      console.error(`  [op ${err.op_index}] ${err.op}: ${err.message}`);
    }
    throw new Error(`Patch failed: ${result.errors.length} operation(s) could not be applied`);
  }

  const mapping = buildDerivedMappingReceipt(timeline, result.timeline, patch.operations);
  let identityReceipt: ReturnType<typeof buildReviewEditIdentityReceipt> | undefined;
  if (mapping) {
    const patchSha256 = computeArtifactSha256(absPatch);
    stampReviewDerivation(result.timeline, baseTimelineSha256, patchSha256, mapping);
  }

  // Issue #35: review-patch geometry changes the primary V1 cuts, so parity
  // must be recomputed and gated inside this serialized canonical route before
  // any patched artifact is promoted. Preserve the caller's documented
  // defaults override while loading the canonical repository defaults here.
  const rhythmDefaultsPath = path.join(findRepoRoot(absProject), "runtime", "compiler-defaults.yaml");
  const rhythmDefaults: CompilerDefaults = {
    ...readYaml<CompilerDefaults>(rhythmDefaultsPath),
    ...(options.defaultsOverride ?? {}),
  };
  const rhythmSyncConfig = resolveRhythmSyncConfig(rhythmDefaults);
  recomputeAndEnforceRhythmSync(
    result.timeline,
    result.timeline.metadata?.rhythm_sync as RhythmSyncCompileMetadata | undefined,
    rhythmSyncConfig.parityGate,
  );
  const patchSourceMap = loadSourceMap(absProject, sourceMapPath);
  const patchReadiness = buildRenderSourceReadiness({
    projectPath: absProject,
    projectId: result.timeline.project_id,
    createdAt: result.timeline.created_at,
    timeline: result.timeline,
    sourceMap: patchSourceMap,
  });
  assertRenderSourceReadiness(patchReadiness);
  result.timeline.metadata = {
    ...(result.timeline.metadata ?? {}),
    source_mapping_hash: patchReadiness.source_mapping_hash,
  };
  if (mapping) {
    identityReceipt = buildReviewEditIdentityReceipt({
      projectDir: absProject,
      timelinePath,
      patchPath: absPatch,
      timeline: result.timeline,
      mapping,
    });
    const mappingValidation = validateAgainstSchema(mapping, "derived-frame-mapping.schema.json");
    if (!mappingValidation.valid) throw new Error(`Derived mapping schema invalid: ${mappingValidation.errors.join("; ")}`);
    const identityValidation = validateAgainstSchema(identityReceipt, "review-edit-identity.schema.json");
    if (!identityValidation.valid) throw new Error(`Review edit identity schema invalid: ${identityValidation.errors.join("; ")}`);
  }
  const patchBeatReport = buildBeatAllocationReport({
    projectId: result.timeline.project_id,
    timeline: result.timeline,
    resolution: result.resolution,
  });
  // Compare-and-swap immediately before the atomic promotion. Any concurrent
  // timeline writer that changed the bytes after the initial read invalidates
  // this patch; the finalizer is never entered with a stale base.
  const latestTimelineSha256 = computeArtifactSha256(timelinePath);
  if (latestTimelineSha256 !== baseTimelineSha256) {
    throw new Error(`canonical timeline changed during patch: base=${baseTimelineSha256} current=${latestTimelineSha256}`);
  }
  if (patch.base_timeline_sha256 !== latestTimelineSha256) {
    throw new Error(`canonical timeline hash mismatch: patch=${patch.base_timeline_sha256} current=${latestTimelineSha256}`);
  }
  const finalized = finalizeCompileArtifactsAtomically({
    projectPath: absProject,
    timeline: result.timeline,
    sourceMap: patchSourceMap,
    targetEndFrame: result.resolution.target_frames,
    resolution: result.resolution,
    duration_policy: patchDurationPolicy,
    validateSourceArtifacts: true,
    sourceReadiness: patchReadiness,
    extraArtifacts: [
      {
        relativePath: "05_timeline/canonical-timeline.json",
        content: canonicalTimelineBytes,
      },
      {
        relativePath: "05_timeline/render-readiness.json",
        content: JSON.stringify(patchReadiness, null, 2),
      },
      {
        relativePath: "05_timeline/beat-allocation-report.json",
        content: JSON.stringify(patchBeatReport, null, 2),
      },
      ...(mapping && identityReceipt ? [
        {
          relativePath: "05_timeline/derived-frame-mapping.json",
          content: `${JSON.stringify(mapping, null, 2)}\n`,
        },
        {
          relativePath: "05_timeline/review-edit-identity.json",
          content: `${JSON.stringify(identityReceipt, null, 2)}\n`,
        },
      ] : []),
    ],
    onPromoted: (_receipts, context) => {
      assertCompileDurationGate({ hardGate: context.duration_policy.hard_gate, resolution: context.resolution });
      assertGeneratedTimelineValid(absProject);
      reconcileCompiledTimelineState(absProject, "compile-timeline", "/compile --patch");
    },
  });
  const manifestPath = finalized.previewManifestPath;

  console.log(`Patch applied: ${result.appliedOps}/${patch.operations.length} ops`);
  console.log(`  Version: ${timeline.version} → ${result.timeline.version}`);
  console.log(`  Markers: ${result.timeline.markers.length}`);
  console.log(`  Preview manifest: ${manifestPath}`);
  console.log(`  Resolution: ${JSON.stringify(result.resolution)}`);

  if (!result.resolution.duration_fit) {
    console.error(
      `WARNING: Post-patch duration is outside the target window ` +
      `(content=${result.resolution.content_frames ?? result.resolution.total_frames} frames, ` +
      `target=${result.resolution.target_frames} frames)`,
    );
  }

  console.log("Schema validation: PASSED");
}

/**
 * Public --patch entry (used by the CLI script and hostile tests): thin
 * delegation to the canonical patch route.
 */
export async function runPatch(
  projectPath: string,
  patchPath: string,
  sourceMapPath?: string,
  options: { defaultsOverride?: Partial<CompilerDefaults> } = {},
): Promise<void> {
  await runCanonicalPatch(projectPath, patchPath, sourceMapPath, options);
}

/**
 * Canonical --patch route: joins the same project-keyed mutation sequencer
 * as the compile route and delegates to the private patch mutation.
 */
export async function runCanonicalPatch(
  projectPath: string,
  patchPath: string,
  sourceMapPath?: string,
  options: { defaultsOverride?: Partial<CompilerDefaults> } = {},
): Promise<void> {
  // The exported runPatch wrapper lives in scripts/compile-timeline.ts;
  // this route is the canonical implementation it delegates to.
  const canonicalProject = canonicalProjectPath(projectPath);
  const key = canonicalProjectMutationKey(canonicalProject);
  await enqueueProjectMutation(key, () =>
    applyCanonicalPatchMutation(canonicalProject, patchPath, sourceMapPath, options));
}

/** Canonical compile decision: create a report when missing, then consume the
 * same persisted artifact that the public compile and schema routes inspect. */
async function decideAndCompileAfterFreshGate(opts: CompileOptions): Promise<CompileResult> {
  const projectPath = path.resolve(opts.projectPath);
  const outcome = await runImageQcGate({ projectDir: projectPath });
  if (!outcome.applicable) {
    // Gate does not apply to this project's canonical assets: strict result,
    // the compiler continues.
    return compileCore(opts);
  }
  if (!outcome.report) throw new ImageQcGateError([], ["image_qc_report_missing"]);
  assertImageQcGateOpen(projectPath);
  return compileCore(opts);
}

/**
 * Deterministic same-project ownership: concurrent canonical compiles on the
 * exact same project path share one in-flight sequence (serialized);
 * different projects proceed concurrently. The map entry is cleaned up when
 * the sequence settles.
 */

/**
 * Canonical compile route (no continuation parameters, no capability
 * passing): runs the fresh image-QC orchestration for the project and lets
 * the private compiler-local decision function invoke compileCore.
 *
 * Same-project concurrency is SERIALIZED with per-caller options: a call
 * that arrives while another sequence is in flight waits, then runs its own
 * full QC + compile with its own options — nothing is coalesced and no
 * caller's options are ignored. The chain entry is cleaned up when the last
 * sequence in the chain settles.
 */
export async function runCanonicalCompile(opts: CompileOptions): Promise<CompileResult> {
  const projectPath = canonicalProjectPath(opts.projectPath);
  const key = canonicalProjectMutationKey(projectPath);
  return enqueueProjectMutation(key, () =>
    decideAndCompileAfterFreshGate({ ...opts, projectPath }));
}

function compileCore(opts: CompileOptions): CompileResult {
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
  const existingTimeline = readExistingTimeline(projectPath);
  const sourceMap = loadSourceMap(projectPath, opts.sourceMapPath);
  const sourceIdentities = loadShotAnchorSourceIdentities(projectPath, sourceMap);
  const sourceHashByAssetId = new Map(
    [...sourceIdentities.entries()]
      .map(([assetId, identity]) => [assetId, canonicalAudioProjectionHash(identity.source_content_hash)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );

  const brief = readYaml<CreativeBrief>(briefPath);
  const blueprint = opts.blueprintOverride
    ? loadBlueprintData(opts.blueprintOverride)
    : loadBlueprint(blueprintPath);
  const selects = readYaml<SelectsCandidates>(selectsPath);
  const shotAnchorResolution = resolveShotAnchors({
    blueprint,
    candidates: selects.candidates,
    sourceIdentities,
  });
  assertHookRecompileAllowed(existingTimeline, computeHookFingerprint(blueprint, shotAnchorResolution));
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
  const defaults: CompilerDefaults = {
    ...readYaml<CompilerDefaults>(defaultsPath),
    ...(opts.defaultsOverride ?? {}),
  };
  const continuityPolicy = resolveContinuityPolicy(defaults.continuity);
  const beatSyncConfig = resolveBeatSyncConfig(defaults);
  const rhythmSyncConfig = resolveRhythmSyncConfig(defaults);
  const continuityReorders: ContinuityReorderEvent[] = [];

  const fpsNum = opts.fpsNum ?? 24;
  const fpsDen = opts.fpsDen ?? 1;
  const hasImageCandidates = selects.candidates.some((candidate) => candidate.media_kind === "image");
  const profileResolution = hasImageCandidates ? resolveProfileAndPolicy({
    briefEditorial: brief.editorial,
    editorialSummary: selects.editorial_summary,
    runtimeTargetSec: brief.project.runtime_target_sec,
    sourceMedia: selects.source_media,
    audioPolicy: brief.audio_policy,
  }) : undefined;
  if (profileResolution) {
    blueprint.resolved_profile = profileResolution.resolvedProfile;
    blueprint.resolved_policy = profileResolution.resolvedPolicy;
  }
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
  const narrativeArcContract = evaluateNormalizedNarrativeArcContract(brief, normalized, selects);
  if (narrativeArcContract.status === "fail") {
    throw new NarrativeArcContractError(narrativeArcContract);
  }

  // ── Phase 1.2: Rhythm evidence snapshot (Issue #35) ──────────────
  // The ONE immutable, strict, project-bound rhythm evidence snapshot for the
  // whole compile: the BGM artifact is read exactly once (bytes → digest →
  // parsed analysis, resolved path/origin), EVERY transcript file is read
  // exactly once (digest + parsed doc — feeding both the music word
  // projection and all utterance projections), and the binding verdict is
  // computed here. Scoring, creatorShortVoBroll, utterance snap, adjacency,
  // beat-sync, cut-breath/ending and rhythm-sync all consume THIS snapshot —
  // no phase re-opens the BGM/transcript artifact paths, so an A→B→A race
  // cannot make one phase alter V1 with evidence whose provenance describes
  // other bytes, and missing project ids / source hashes are rejected BEFORE
  // any geometry-affecting phase runs. Unbound/degraded BGM evidence never
  // reaches geometry phases.
  const rhythmEvidence = loadRhythmEvidenceSnapshot(projectPath, {
    projectId: normalized.project_id,
    repoRoot,
    bgmMediaPathOverride: opts.bgmMediaPathOverride,
  });
  const projectUtterances = utterancesFromTranscriptSnapshot(rhythmEvidence.transcripts);

  // ── Phase 1.5: Skill Activation ──────────────────────────────────
  // Determine which editing skills are active based on blueprint + candidates.
  // Fail-open: if no active_editing_skills in blueprint, use empty set (no skill effects).

  const activeSkills = blueprint.active_editing_skills
    ? activateSkills(blueprint, selects.candidates, selects.editorial_summary)
    : [];
  const humanGoldenOrder = activeSkills.includes("human_golden_order");
  const strictHumanGoldenOrder = durationPolicy.mode === "strict" && humanGoldenOrder;
  const exactCandidatePlanOrder = humanGoldenOrder ||
    activeSkills.includes("longform_reduction");
  const apexFreezeHoldConfig = getApexFreezeHoldConfig(activeSkills, fpsNum, fpsDen);
  const candidatePlanFreezeHolds = apexFreezeHoldConfig
    ? materializeCandidatePlanFreezeHolds(blueprint, selects.candidates)
    : [];
  const creatorShortVoBroll = resolveCreatorShortVoBrollPreset(
    brief,
    blueprint,
    selects,
    fpsNum,
    fpsDen,
    exactCandidatePlanOrder,
    projectUtterances,
  );
  if (exactCandidatePlanOrder && profileResolution?.resolvedProfile.id !== "lyric_mv") {
    applyExactCandidatePlanRevisitExemptions(normalized.beats, selects.candidates);
  }
  if (profileResolution?.resolvedProfile.id === "lyric_mv") {
    applyIntentionalStillReuseExemptions(normalized.beats, selects.candidates);
  }
  const retentionPolicyProvenance = blueprint.policy_refs?.retention_policy_ref
    ? (() => {
      const resolved = resolveRetentionPolicyArtifact(projectPath, blueprint.policy_refs!.retention_policy_ref!);
      return {
        policy: "retention-policy/v1" as const,
        policy_ref: resolved.relativePath,
        policy_id: resolved.policy.policy_id,
        policy_hash: resolved.contentHash,
        degrade_order: resolved.policy.degrade_order,
      };
    })()
    : undefined;

  // ── Phase 2: Score ────────────────────────────────────────────────

  // Use fps from compile options if provided, otherwise default to 24fps.
  // For source material at 30fps, pass fpsNum: 30 via compile options.
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const bgmDurationUs = resolveBgmDurationUs(opts, blueprint);
  const maxDurationFrames = bgmDurationUs
    ? Math.floor(bgmDurationUs / usPerFrame)
    : undefined;

  // The ONE rhythm evidence snapshot was created at compile entry (above);
  // bgmAnalysis is its bound view — see the entry block for the contract.
  const bgmAnalysis = rhythmEvidence.bgmBound ? rhythmEvidence.bgm?.analysis : undefined;
  const stillHoldContext = buildStillHoldResolutionContext(bgmAnalysis, fpsNum, fpsDen);
  let bgmScoringContext: BgmScoringContext | undefined;
  if (bgmAnalysis) {
    // Defensive copies: phases must not mutate the shared snapshot.
    bgmScoringContext = {
      downbeats_sec: [...bgmAnalysis.downbeats_sec],
      sections: bgmAnalysis.sections.map((section) => ({ ...section })),
      beats: (bgmAnalysis.beats ?? []).map((beat) => ({ ...beat })),
      fpsNum,
    };
  }
  const beatSyncGrid = loadBeatSyncGridFromProject(projectPath, fpsNum, {
    bgmFromSnapshot: bgmAnalysis,
    snapshotResolved: true,
    // The guarded Issue #35 route must own admission of M2 cues before any
    // legacy beats_sec/downbeats_sec or music_cues.json can move geometry.
    // Route-off and non-M2 evidence retain the explicit legacy behavior.
    disableLegacyPreQuantization: rhythmSyncConfig.mode !== "off" &&
      hasM2BgmProvenance(rhythmEvidence.bgm?.analysis),
  });

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
    stillHoldContext,
  );

  // ── Phase 2.5: Resolve Timeline Order & Output Dimensions ────────
  const timelineOrder = resolveTimelineOrder(blueprint, blueprint.resolved_profile?.id, brief);
  const sourceAssetIds = new Set(
    selects.candidates
      .filter(candidateSupportsVisual)
      .map((candidate) => candidate.asset_id)
      .filter((assetId): assetId is string => typeof assetId === "string" && assetId.length > 0),
  );
  const sourceDimensions = sourceAssetIds.size > 0
    ? readSourceVideoDimensions(projectPath, sourceAssetIds)
    : [];
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
    stillHoldContext,
    ...(creatorShortVoBroll ? { creatorShortVoBroll } : {}),
  });
  const intentionalOperations = (blueprint.timeline_operations ?? []) as IntentionalGapOperation[];
  for (const operation of intentionalOperations) {
    const validation = validateIntentionalGapOperation(operation);
    if (!validation.valid) throw new TimelineOperationError(operation, validation.errors);
  }
  if (intentionalOperations.length > 0) assembled.operations = intentionalOperations;

  // ── Primary audio mix policy (Issue #6 P0) ────────────────────────
  // An explicit, authority-bearing mix policy may declare the primary audio
  // lane intentionally non-continuous. A malformed declaration fails closed.
  if (blueprint.audio_mix_policy != null) {
    const policyValidation = validatePrimaryAudioMixPolicy(blueprint.audio_mix_policy);
    if (!policyValidation.valid) {
      throw new Error(`invalid_audio_mix_policy: ${policyValidation.errors.join("; ")}`);
    }
  }
  // bgm_only is itself an explicit brief-level mix policy: the music bed is the
  // program audio and no original-audio mirrors are generated.
  const primaryAudioCoverageWaived = audioPolicy.mode === "bgm_only" ||
    audioPolicy.mode === "music_master" ||
    blueprint.audio_mix_policy?.mode === "selective_authorization";
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
  const trimRangeReport: TrimRangeReport[] = [];
  applyAdaptiveTrim(
    trimmableAssembledClips,
    selects.candidates,
    blueprint,
    normalized.beats,
    usPerFrame,
    clipTrimPlans,
    {
      preserveAuthoredRanges: strictHumanGoldenOrder,
      rangeReport: trimRangeReport,
    },
  );
  const v1Track = assembled.tracks.video.find((track) => track.track_id === "V1");
  if (v1Track && !strictHumanGoldenOrder) {
    compactTrimmedClipsWithinBeats(v1Track.clips, normalized.beats, assembled.markers);
  }

  // ── Phase 3.5b: Duration Adjustment (strict mode) ───────────────
  applyDurationAdjust(
    assembled,
    normalized.beats,
    selects.candidates,
    durationPolicy,
    fpsNum,
    fpsDen,
    stillDurationPolicy,
    { preserveAuthoredRanges: strictHumanGoldenOrder },
  );

  // ── Phase 3.5c: Utterance-boundary snap ──────────────────────────
  // When a snapping skill is active, or a talking-head project explicitly asks
  // to preserve natural breath, move clip in/out onto clean utterance edges so
  // dialogue cuts land on phrase boundaries (review metric audio.speech_cut).
  // Runs after duration adjust so it sees the final clip set; resolve (Phase 4)
  // then sanitizes any overlap. No-op for projects without transcripts or
  // non-talking-head projects without an active snap skill.
  const snapConfig = resolveUtteranceSnapConfig(activeSkills, blueprint, selects);
  if (snapConfig && !strictHumanGoldenOrder) {
    const utteranceMap = projectUtterances;
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

  const resolution = resolve(assembled, normalized.total_duration_frames, selects.candidates, durationPolicy, fpsNum, fpsDen, {
    primaryAudioCoverageWaived,
  });
  if (exactCandidatePlanOrder) {
    assertExactCandidatePlanAgreement(blueprint, selects.candidates, assembled, resolution);
  }

  // ── Phase 4.5: Adjacency Decide ──────────────────────────────────
  // Analyze adjacent clip pairs on V1 and assign transition skills.
  // Only runs when active editing skills are available.

  let adjacencyTransitions: import("./transition-types.js").TimelineTransition[] = [];
  let pendingAdjacencyAnalysis: import("./transition-types.js").AdjacencyAnalysis | undefined;
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

      for (const tr of strictHumanGoldenOrder ? [] : adjacencyTransitions) {
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

      // Set project_id on analysis. The artifact itself is written after the
      // Issue #34 overlap pass so degradation recorded there lands in the
      // analysis too (pairs always describe the final transition decisions).
      adjResult.analysis.project_id = normalized.project_id;
      pendingAdjacencyAnalysis = adjResult.analysis;
    }
  }
  removeOverlappingGeneratedAudioMirrors(assembled);

  const beatSyncMinDurationFrames = Math.max(
    MIN_RENDERABLE_FRAMES,
    Math.floor(blueprint.trim_policy?.default_min_duration_frames ?? 0),
  );
  const beatSyncMetadata = strictHumanGoldenOrder
    ? undefined
    : applyCutBeatQuantize(assembled, {
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

  // ── Phase 4.6: Rhythm Sync (Issue #35) ────────────────────────────
  // Multi-source rhythm snap on the PRIMARY V1 track only: pull canonical cut
  // boundaries onto music onsets/downbeats and word-level STT heads (±1.5s
  // search, Hard Snap at chorus section starts), then verify Gap 0f / Overrun
  // 0f integrity and run the ±2-frame parity gate measured from the actual
  // section start frames. Fail-open: without rhythm evidence the pass records
  // an explicit degraded state and changes nothing. With parity_gate
  // "enforce" (default), a chorus parity failure after post-snap geometry
  // passes blocks the canonical compile; "off" is the documented opt-out.
  let rhythmSyncMetadata = strictHumanGoldenOrder
    ? undefined
    : applyRhythmSyncSnaps(assembled, {
        mode: rhythmSyncConfig.mode,
        grid: rhythmSyncConfig.mode === "off"
          ? { events: [], majorSections: [], status: "unavailable", sources: { bgm_analysis: false, word_timestamps: false, beat_count: 0, word_count: 0, section_count: 0 }, degraded_reasons: [], evidence: { binding: "unbound", binding_failures: [] } }
          : buildRhythmEventGridFromSnapshot(rhythmEvidence, fpsNum, fpsDen, rhythmSyncConfig.minCueConfidence),
        fpsNum,
        fpsDen,
        searchWindowSec: rhythmSyncConfig.searchWindowSec,
        maxShiftFrames: rhythmSyncConfig.maxShiftFrames,
        minCueConfidence: rhythmSyncConfig.minCueConfidence,
        parityMaxOffsetFrames: rhythmSyncConfig.parityMaxOffsetFrames,
        minDurationFrames: beatSyncMinDurationFrames,
        parityGate: rhythmSyncConfig.parityGate,
        sourceDurations: loadSourceDurationsFromProject(projectPath),
      });
  if (rhythmSyncMetadata?.enabled && rhythmSyncMetadata.counts.snapped > 0) {
    syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
    removeOverlappingGeneratedAudioMirrors(assembled);
    refreshTransitionCutFrames(adjacencyTransitions, assembled);
  }

  // Authored holds run after every source-boundary adjustment so transition
  // and beat snapping cannot reinterpret hold frames as source-media frames.
  const apexFreezeHold = applyApexFreezeHolds(
    assembled,
    selects.candidates,
    apexFreezeHoldConfig,
    candidatePlanFreezeHolds,
  );
  if (apexFreezeHold.total_added_frames > 0) {
    refreshTransitionCutFrames(adjacencyTransitions, assembled);
  }

  // ── Phase 4.6: Issue #34 A/B roll overlap geometry ────────────────
  // Overlap presets (film_crossfade / light_leak_flash / dreamy_focus_blur)
  // need physical head material on the incoming clip: shift its placement
  // earlier by transition_frames and extend its source head. Program duration
  // is unchanged (max end identical), so Gap 0 / Overrun 0 is structural.
  // Infeasible transitions degrade explicitly to cut with a recorded reason.
  if (adjacencyTransitions.length > 0 && assembled.tracks.video.length > 0) {
    const overlapResult = applyTransitionOverlaps(
      assembled.tracks.video[0],
      adjacencyTransitions,
      { fpsNum, fpsDen },
    );
    if (overlapResult.applied.length > 0) {
      syncGeneratedAudioMirrorsWithPrimaryVideo(assembled);
      removeOverlappingGeneratedAudioMirrors(assembled);
      refreshTransitionCutFrames(adjacencyTransitions, assembled);
    }
    // Propagate degradation into the adjacency analysis so downstream QA and
    // review tooling see the final transition decisions, not pre-overlap
    // intent. The pair's transition_type becomes "cut" and a reason code
    // records exactly why the A/B blend was refused.
    if (pendingAdjacencyAnalysis && overlapResult.degraded.length > 0) {
      const degradedByToClip = new Map(overlapResult.degraded.map((d) => [d.to_clip_id, d]));
      for (const pair of pendingAdjacencyAnalysis.pairs) {
        if (!pair.right_clip_id) continue;
        const degraded = degradedByToClip.get(pair.right_clip_id);
        if (!degraded) continue;
        pair.transition_type = "cut";
        pair.selection_rationale?.reason_codes.push(
          `transition_overlap_degraded:${degraded.reason}`,
        );
      }
    }
    for (const degraded of overlapResult.degraded) {
      opts.log?.(`[transition-overlap] degraded ${degraded.transition_id} (${degraded.to_clip_id}): ${degraded.reason}`);
    }
  }
  if (pendingAdjacencyAnalysis) {
    writeAdjacencyAnalysis(pendingAdjacencyAnalysis, projectPath);
  }

  // Apex freeze holds ripple later clip positions after the snap pass, so
  // re-measure chorus/section parity (against actual section starts) and the
  // Gap 0f / Overrun 0f integrity from the primary V1 geometry before the
  // parity gate runs. Recompute + gate also run after review patches,
  // cut-breath and ending treatments so the FINAL stamped metadata reflects
  // the FINAL V1 cuts.
  recomputeAndEnforceRhythmSync(assembled, rhythmSyncMetadata, rhythmSyncConfig.parityGate);

  const avSync = synchronizeSameSourceTalkCuts(assembled);
  const coverageEndFrame = resolveCoverageHorizon(assembled, resolution.target_frames, durationPolicy);

  if (hasVisualProgram(assembled)) {
    const availableFrames = primaryVideoEndFrame(assembled);
    const primaryVideoGaps = findPrimaryVideoGaps(assembled, coverageEndFrame);
    if (durationPolicy.mode === "strict" && primaryVideoGaps.length > 0 && availableFrames < resolution.target_frames) {
      throw new InsufficientContentError({
        target_frames: resolution.target_frames,
        available_frames: availableFrames,
        shortfall_frames: resolution.target_frames - availableFrames,
        reason: strictHumanGoldenOrder ? "approved_range" : "renderable_content",
      });
    }
    if (primaryVideoGaps.length > 0) throw new GapFreeTimelineError(primaryVideoGaps);
  }

  // ── Primary audio coverage invariant (Issue #6 P0) ────────────────
  // Under picture, the primary audio lane (A1) must be continuous like V1;
  // without picture, the authored audio lanes together are the program.
  // Unintended silence fails closed unless a valid explicit operation covers
  // the range or an explicit mix policy waived continuity above. Rendering a
  // hole as silent audio is never an implicit compile outcome.
  const hasPrimaryAudioProgram = hasVisualProgram(assembled) ||
    assembled.tracks.audio.some((track) => track.clips.length > 0);
  if (hasPrimaryAudioProgram && !primaryAudioCoverageWaived) {
    const primaryAudioGaps = findPrimaryAudioGaps(assembled, coverageEndFrame);
    if (primaryAudioGaps.length > 0) throw new PrimaryAudioGapError(primaryAudioGaps);
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

  const lyricMvMetadata = profileResolution?.resolvedProfile.id === "lyric_mv"
    ? buildLyricMvTimelineMetadata(
        profileResolution.profileDefaults?.lyric_mv_thresholds,
        bgmAnalysis,
        fpsNum,
        fpsDen,
      )
    : undefined;

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
    creatorShortVoBrollProvenance: creatorShortVoBroll?.provenance,
    retentionPolicyProvenance,
    transitions: adjacencyTransitions.length > 0 ? adjacencyTransitions : undefined,
    width: outputDims.width,
    height: outputDims.height,
    outputAspectRatio: outputDims.output_aspect_ratio,
    letterboxPolicy: outputDims.letterbox_policy,
    metadata: {
      continuity,
      ...(lyricMvMetadata ? { lyric_mv: lyricMvMetadata } : {}),
      ...(beatSyncMetadata ? { beat_sync: beatSyncMetadata } : {}),
      ...(rhythmSyncMetadata ? { rhythm_sync: rhythmSyncMetadata } : {}),
      av_sync: {
        policy: "same-source-talk-exact/v1",
        checked_pairs: avSync.checked_pairs,
        synchronized_clip_ids: avSync.synchronized_clip_ids,
      },
      ...(blueprint.policy_refs?.audio_delivery_profile_ref ? {
        audio_delivery_profile_ref: {
          ref: blueprint.policy_refs.audio_delivery_profile_ref.ref,
          ...(blueprint.policy_refs.audio_delivery_profile_ref.version
            ? { version: blueprint.policy_refs.audio_delivery_profile_ref.version }
            : {}),
          ...(blueprint.policy_refs.audio_delivery_profile_ref.source_hash
            ? { source_hash: blueprint.policy_refs.audio_delivery_profile_ref.source_hash }
            : {}),
          ...(blueprint.policy_refs.audio_delivery_profile_ref.profile_hash
            ? { profile_hash: blueprint.policy_refs.audio_delivery_profile_ref.profile_hash }
            : {}),
        },
      } : {}),
      ...(trimRangeReport.length > 0 ? { trim_range_report: trimRangeReport } : {}),
      ...(apexFreezeHold.total_added_frames > 0 ? {
        apex_freeze_hold: {
          policy: "apex-freeze-hold/v1",
          applied_clip_ids: apexFreezeHold.applied_clip_ids,
          total_added_frames: apexFreezeHold.total_added_frames,
        },
      } : {}),
      ...(creatorShortVoBroll ? {
        creator_short_vo_broll: creatorShortVoBroll.provenance,
      } : {}),
      ...(retentionPolicyProvenance ? {
        retention_evidence: {
          producer: "compiler",
          policy_ref: retentionPolicyProvenance.policy_ref,
          policy_hash: retentionPolicyProvenance.policy_hash,
        },
      } : {}),
    },
  });

  const anchorBindings = bindShotAnchorsToTimeline(shotAnchorResolution, timelineIR);
  if (shotAnchorResolution) {
    timelineIR.provenance.shot_anchor_resolution = shotAnchorResolution;
  }
  const hookLock = buildHookLockProvenance({
    blueprint,
    resolution: shotAnchorResolution,
    timeline: timelineIR,
    existingLock: existingTimeline?.provenance.hook_lock,
  });
  if (hookLock) timelineIR.provenance.hook_lock = hookLock;
  if (anchorBindings.length > 0 && timelineIR.metadata) {
    const existingAnchorMetadata = timelineIR.metadata.shot_anchor as Record<string, unknown> | undefined;
    timelineIR.metadata.shot_anchor = {
      ...(existingAnchorMetadata ?? {}),
      binding_count: anchorBindings.length,
      clip_ids: anchorBindings.map((binding) => binding.clip_id),
    };
  }

  if (blueprint.visual_intents && blueprint.visual_intents.length > 0) {
    const framingPolicy = resolveFramingPolicyArtifact(projectPath, blueprint);
    const reframeCandidates = resolveReframeCandidateArtifacts(projectPath, blueprint.visual_intents, framingPolicy.contentHash);
    timelineIR = projectRegisteredVisualIntents(timelineIR, blueprint.visual_intents, {
      framing_policy: framingPolicy.policy,
      framing_policy_ref: framingPolicy.relativePath,
      source_identities: sourceIdentities,
      reframe_candidates: reframeCandidates,
    });
    const verticalReference = blueprint.policy_refs?.vertical_composition_policy_ref;
    if (verticalReference) {
      const verticalPolicy = resolveVerticalCompositionPolicyArtifact(projectPath, verticalReference);
      const verticalResults = blueprint.visual_intents.map((intent) => {
        const observations = intent.framing_input?.observations ?? [];
        const first = observations[0];
        const last = observations.at(-1) ?? first;
        const representativeCount = verticalPolicy.policy.frames.representative_count;
        const representatives = representativeCount > 0
          ? Array.from({ length: representativeCount }, (_, index) => observations[Math.floor(((index + 1) * observations.length) / (representativeCount + 1))])
          : [];
        const candidate = intent.reframe_candidate_ref ? reframeCandidates.get(intent.reframe_candidate_ref) : undefined;
        const sourceAvGeometry = timelineIR.metadata?.source_av_geometry
          ?? readSourceAvGeometry(projectPath, new Set(intent.source_evidence.map((evidence) => evidence.asset_id)));
        const resolution = resolveVerticalComposition({
          intent,
          source_identity: intent.source_evidence[0],
          ...(sourceAvGeometry && typeof sourceAvGeometry === "object" ? { source_av_geometry: sourceAvGeometry as Parameters<typeof resolveVerticalComposition>[0]["source_av_geometry"] } : {}),
          frames: [
            ...(first ? [{ role: "first" as const, observation: first }] : []),
            ...representatives.filter(Boolean).map((observation) => ({ role: "representative" as const, observation })),
            ...(last ? [{ role: "last" as const, observation: last }] : []),
          ],
          framing_policy: framingPolicy.policy,
          ...(candidate ? { reframe_candidate: candidate } : {}),
        }, verticalPolicy.policy);
        const failedFinding = resolution.findings.find((item) => item.status !== "pass");
        return { intent_id: intent.intent_id, status: resolution.status, receipt_hash: resolution.receipt_hash, ...(failedFinding ? { reason: failedFinding.reason } : {}) };
      });
      timelineIR.provenance.vertical_composition = {
        policy: "vertical-composition-resolution/v1",
        policy_ref: verticalPolicy.relativePath,
        policy_hash: verticalPolicy.contentHash,
        results: verticalResults,
      };
    }
  }

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
    // applyPatch deep-clones the timeline, so the stamped rhythm metadata is
    // now a detached copy: re-fetch it and re-measure parity/integrity (and
    // enforce the gate) against the POST-PATCH V1 geometry.
    rhythmSyncMetadata = recomputeAndEnforceRhythmSync(
      timelineIR,
      timelineIR.metadata?.rhythm_sync as RhythmSyncCompileMetadata | undefined,
      rhythmSyncConfig.parityGate,
    ) ?? rhythmSyncMetadata;
  }

  const cutBreathTreatment = strictHumanGoldenOrder
    ? { totalExtendedFrames: 0 }
    : applyCutBreathTreatment(
        timelineIR,
        blueprint.dialogue_policy,
        loadProjectSegments(projectPath),
        projectUtterances,
        fpsNum / fpsDen,
      );
  if (cutBreathTreatment.totalExtendedFrames > 0) {
    finalResolution = extendResolutionForEnding(
      finalResolution,
      cutBreathTreatment.totalExtendedFrames,
    );
  }

  const endingTreatment = strictHumanGoldenOrder
    ? { extendedFrames: 0 }
    : applyEndingTreatment(
        timelineIR,
        blueprint.ending_policy,
        loadProjectSegments(projectPath),
        fpsNum / fpsDen,
        projectUtterances,
      );
  if (endingTreatment.extendedFrames > 0) {
    finalResolution = extendResolutionForEnding(
      finalResolution,
      endingTreatment.extendedFrames,
    );
  }

  // ── Rhythm parity: final recompute + gate ─────────────────────────
  // Review patches, cut-breath and ending treatments all mutate V1 geometry
  // after the snap pass. Re-measure parity/integrity from the FINAL timeline
  // and enforce the gate one last time so timeline.metadata.rhythm_sync —
  // the contract preview and render consume — reflects the final V1 cuts.
  rhythmSyncMetadata = recomputeAndEnforceRhythmSync(
    timelineIR,
    timelineIR.metadata?.rhythm_sync as RhythmSyncCompileMetadata | undefined,
    rhythmSyncConfig.parityGate,
  ) ?? rhythmSyncMetadata;

  timelineIR = projectProjectMusicCues(
    timelineIR,
    projectPath,
    audioPolicy.mode,
    fpsNum,
    fpsDen,
  );
  const resolvedSfxCuePlan = resolveProjectSfxCuePlan(
    timelineIR,
    projectPath,
    audioPolicy.mode,
    fpsNum,
    fpsDen,
    opts.repoSfxRoot,
  );
  if (resolvedSfxCuePlan) {
    timelineIR = projectSfxToTimeline(timelineIR, resolvedSfxCuePlan);
  }
  timelineIR = projectProjectAudioPolicy(timelineIR, {
    mode: audioPolicy.mode,
    source: audioPolicy.source,
    a1_loudnorm: audioPolicy.a1_loudnorm,
    ...(audioPolicy.audio_decision ? { audio_decision: audioPolicy.audio_decision } : {}),
    ...(audioPolicy.music_master ? { music_master: audioPolicy.music_master } : {}),
  }, sourceMap, sourceHashByAssetId);

  assertStillImageTimelineTruthForTimeline(timelineIR);

  // ── Render source readiness (Issue #6 P1) ─────────────────────────
  // Resolve every timeline asset back to a source path before promotion so
  // unresolved/missing/hash-mismatched/unreadable media fail closed ahead of
  // any render process. External references are recorded with a read-only
  // canonical source root. Enforcement follows validateSourceArtifacts, the
  // same flag production render routes already require; the mapping identity
  // is always stamped so preview and render share one contract.
  const enforceRenderReadiness = opts.validateSourceArtifacts === true;
  const renderReadiness = buildRenderSourceReadiness({
    projectPath,
    projectId: timelineIR.project_id,
    createdAt: opts.createdAt,
    timeline: timelineIR,
    sourceMap,
    formalSfxSources: resolvedSfxCuePlan
      ? buildFormalSfxSourceAuthorities(resolvedSfxCuePlan, projectPath, opts.repoSfxRoot)
      : undefined,
  });
  timelineIR.metadata = {
    ...(timelineIR.metadata ?? {}),
    source_mapping_hash: renderReadiness.source_mapping_hash,
  };
  if (enforceRenderReadiness) {
    assertRenderSourceReadiness(renderReadiness);
  }

  // ── Operator diagnostics (Issue #6 P1) ────────────────────────────
  // Beat allocation report: target vs resolved frames, gap/overrun, and the
  // source ranges behind every beat, so problems like a 65-frame hole are
  // readable without opening timeline.json.
  const beatAllocationReport = buildBeatAllocationReport({
    projectId: timelineIR.project_id,
    timeline: timelineIR,
    resolution: finalResolution,
    trimRangeReport,
  });

  const atomicFinalize: AtomicCompileFinalizeResult = finalizeCompileArtifactsAtomically({
    projectPath,
    timeline: timelineIR,
    sourceMap,
    targetEndFrame: finalResolution.target_frames,
    resolution: finalResolution,
    duration_policy: durationPolicy,
    validateSourceArtifacts: opts.validateSourceArtifacts,
    sourceReadiness: enforceRenderReadiness ? renderReadiness : undefined,
    primaryAudioCoverageWaived,
    extraArtifacts: enforceRenderReadiness
      ? [
          {
            relativePath: "05_timeline/render-readiness.json",
            content: JSON.stringify(renderReadiness, null, 2),
          },
          {
            relativePath: "05_timeline/beat-allocation-report.json",
            content: JSON.stringify(beatAllocationReport, null, 2),
          },
        ]
      : undefined,
    onPromoted: opts.onArtifactsPromoted,
  });
  const outputPath = atomicFinalize.outputPath;
  const otioPath = exportOtio(timelineIR, projectPath);
  const previewManifestPath = atomicFinalize.previewManifestPath;

  return {
    timeline: timelineIR,
    outputPath,
    otioPath,
    previewManifestPath,
    resolution: finalResolution,
    duration_policy: durationPolicy,
    continuity,
    trim_range_report: trimRangeReport,
    ...(enforceRenderReadiness ? { render_readiness: renderReadiness } : {}),
    beat_allocation_report: beatAllocationReport,
    artifact_receipts: atomicFinalize.receipts,
    ...(beatSyncMetadata ? { beat_sync: beatSyncMetadata } : {}),
    ...(rhythmSyncMetadata ? { rhythm_sync: rhythmSyncMetadata } : {}),
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
  if (!brief.audio_policy && brief.music_master) {
    throw new Error("music_master declaration requires audio_policy=music_master; no fallback is allowed.");
  }
  if (brief.audio_policy) {
    if (brief.audio_policy === "music_master") {
      if (!brief.music_master) {
        throw new Error("music_master audio policy requires an explicit music_master brief declaration.");
      }
      return {
        mode: "music_master",
        source: "explicit_brief",
        a1_loudnorm: resolveA1Loudnorm(brief, blueprint, repoRoot),
        audio_decision: brief.music_master.audio_decision ?? "preserve",
        music_master: canonicalBriefMusicMaster(brief.music_master),
      };
    }
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

function canonicalBriefMusicMaster(declaration: CreativeBriefMusicMaster): CreativeBriefMusicMaster {
  const normalizedRef = declaration.source_ref.replace(/\\/g, "/");
  if (
    normalizedRef.length === 0
    || path.isAbsolute(declaration.source_ref)
    || normalizedRef.startsWith("/")
    || /^[A-Za-z]:\//.test(normalizedRef)
    || normalizedRef.split("/").includes("..")
    || normalizedRef.split("/").some((part) => part.length === 0 || part === ".")
  ) {
    throw new Error("music_master source_ref must be a project-relative canonical reference.");
  }
  return {
    asset_id: declaration.asset_id ?? "music_master",
    source_ref: normalizedRef,
    source_content_hash: declaration.source_content_hash,
    source_size_bytes: declaration.source_size_bytes,
    source_duration_us: declaration.source_duration_us,
    ...(declaration.source_range_us ? { source_range_us: { ...declaration.source_range_us } } : {}),
    ...(declaration.timeline_range ? { timeline_range: { ...declaration.timeline_range } } : {}),
    gain_linear: declaration.gain_linear ?? 1,
    audio_decision: declaration.audio_decision ?? "preserve",
    ...(declaration.channel_layout ? { channel_layout: declaration.channel_layout } : {}),
    ...(declaration.codec ? { codec: declaration.codec } : {}),
    ...(declaration.processing_graph ? {
      processing_graph: {
        version: declaration.processing_graph.version,
        operations: [...declaration.processing_graph.operations],
      },
    } : {}),
    ...(declaration.measurement_tolerance ? {
      measurement_tolerance: { ...declaration.measurement_tolerance },
    } : {}),
    ...(declaration.policy_hash ? { policy_hash: declaration.policy_hash } : {}),
  };
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
