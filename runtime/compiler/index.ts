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
import { applyAdaptiveTrim, applyUtteranceSnap, type UtteranceSpan } from "./trim.js";
import { applyDurationAdjust } from "./duration-adjust.js";
import { resolve } from "./resolve.js";
import { buildTimelineIR, exportOtio, writePreviewManifest, writeTimeline } from "./export.js";
import { applyPatch } from "./patch.js";
import { resolveDurationPolicyFromBlueprint, resolveOutputDimensions, resolveTimelineOrder } from "./duration-helpers.js";
import { activateSkills, computeRegistryHash, getSkillMetadataTags, getUtteranceSnapConfig } from "../editorial/skill-registry.js";
import { loadProfiles } from "../editorial/policy-resolver.js";
import { adjacencyDecide, writeAdjacencyAnalysis, applyBeatSnap } from "./adjacency.js";
import { loadBgmAnalysisFromProject } from "../media/bgm-analyzer.js";
import { loadSourceMap } from "../media/source-map.js";
import { extractDurationUs, runFfprobe } from "../connectors/ffprobe.js";
import { attachAutoCaptions, resolveCaptionPolicy } from "../captions/timeline-captions.js";
import { materializePeakSignalsFromSegments } from "../artifacts/peak-materialization.js";
import type { BgmScoringContext } from "./score.js";
import type {
  CompileOptions,
  CompilerDefaults,
  CreativeBrief,
  AssembledTimeline,
  BriefAudioPolicy,
  DurationPolicy,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "./types.js";

export type { TimelineIR, CompileOptions };
export { applyPatch } from "./patch.js";
export type { ReviewPatch, PatchResult, PatchError, PatchOperation } from "./patch.js";
export type { ResolutionReport } from "./resolve.js";

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

  // ── Phase 3: Assemble ─────────────────────────────────────────────

  const assembled = assemble(normalized, rankedTable, defaults.scoring, fpsNum, fpsDen, durationPolicy, {
    timelineOrder,
    beatOrder: normalized.beats.map((beat) => beat.beat_id),
    trackLayout,
    audioPolicy: audioPolicy.mode,
    a1Loudnorm: audioPolicy.a1_loudnorm,
    bgmAssetId: blueprint.music_policy.bgm_asset_id,
    bgmSegmentId: blueprint.music_policy.bgm_segment_id,
    bgmDurationSec: blueprint.music_policy.bgm_duration_sec,
    maxDurationFrames,
    log: opts.log,
  });

  // ── Phase 3.5: Adaptive Trim ────────────────────────────────────
  // Apply center-based trim when trim_hint is available.
  // Falls back to authored range when no hints exist.

  const allAssembledClips = [
    ...assembled.tracks.video.flatMap((t) => t.clips),
    ...assembled.tracks.audio.flatMap((t) => t.clips),
  ];
  applyAdaptiveTrim(allAssembledClips, selects.candidates, blueprint, normalized.beats, usPerFrame);

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

  // ── Phase 4: Resolve constraints ──────────────────────────────────

  const resolution = resolve(assembled, normalized.total_duration_frames, selects.candidates, durationPolicy, fpsNum, fpsDen);

  // ── Phase 4.5: Adjacency Decide ──────────────────────────────────
  // Analyze adjacent clip pairs on V1 and assign transition skills.
  // Only runs when active editing skills are available.

  let adjacencyTransitions: import("./transition-types.js").TimelineTransition[] = [];

  if (activeSkills.length > 0 && assembled.tracks.video.length > 0) {
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
            const committed = applyBeatSnap(left, right, snapDelta, fpsNum);
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
