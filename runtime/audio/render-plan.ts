import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveAudioGainWithFallback } from "../../editor/shared/audio-gain.js";
import type { AudioMix, ClipOutput, TimelineIR } from "../compiler/types.js";
import { loadSourceMap } from "../media/source-map.js";
import {
  resolveExplicitBgmTrack,
  type ResolvedPinnedBgmTrack,
} from "../music/cue-planner.js";
import type { PackRegistryOptions } from "../music/pack-registry.js";
import {
  resolveAudioFinishPolicy,
  type ResolvedAudioFinishPolicy,
} from "./dialogue-finishing.js";
import {
  validateMusicCues,
  type MusicCueV2,
  type MusicCuesDoc,
} from "./music-cues.js";
import { DEFAULT_MASTERING, type MasteringDefaults } from "./mastering.js";
import {
  resolveSfxCuePlan,
  type ResolvedSfxCue,
  type ResolvedSfxCuePlan,
  type SfxSemanticRole,
} from "./sfx-cues.js";

export type AudioRenderStrategy =
  | "explicit_music_cues_v2"
  | "explicit_sfx_cues_v1"
  | "explicit_music_and_sfx_cues_v1"
  | "dialogue_only"
  | "original_passthrough"
  | "legacy_embedded_bgm";

export type DialogueFinishScope =
  | "a1_only"
  | "none"
  | "none_original_passthrough"
  | "none_mixed_legacy";

export interface AudioRenderSourceClip {
  track_id: "A1";
  clip_id: string;
  asset_id: string;
  role: "dialogue" | "nat_sound";
  source_path: string;
  source_content_hash: string;
  source_size_bytes: number;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  gain_linear: number;
}

export interface AudioRenderResolvedTrack {
  track_id: string;
  pack_id: string;
  pack_version: string;
  pack_manifest_hash: string;
  full_mix_path: string;
  full_mix_content_hash: string;
  full_mix_size_bytes: number;
  analysis_content_hash: string;
  analysis_size_bytes: number;
  analysis_status: "ready" | "degraded" | "failed" | "unavailable";
  duration_us: number;
}

export interface AudioRenderCue {
  cue_id: string;
  track_id: string;
  source_path: string;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  semantic_anchor: MusicCueV2["semantic_anchor"];
  section: string;
  phase: string;
  applied: {
    base_gain_db: number;
    duck_gain_db: number;
    fade_in_ms: number;
    fade_out_ms: number;
    attack_ms: number;
    release_ms: number;
  };
  pins: {
    pack_id: string;
    pack_version: string;
    pack_manifest_hash: string;
    full_mix_content_hash: string;
    full_mix_size_bytes: number;
    analysis_content_hash: string;
    analysis_size_bytes: number;
    analysis_status: AudioRenderResolvedTrack["analysis_status"];
  };
}

export interface AudioRenderSfxCue {
  cue_id: string;
  semantic_role: SfxSemanticRole;
  asset_id: string;
  source_path: string;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  trigger_frame: number;
  duration_frames: number;
  dialogue_overlap_frames: number;
  applied: {
    gain_db: number;
    fade_in_ms: number;
    fade_out_ms: number;
    duck_group: "dialogue" | "none";
    duck_gain_db: number;
    attack_ms: number;
    release_ms: number;
  };
  tail_processing: ResolvedSfxCue["tail_processing"];
  pins: ResolvedSfxCue["asset_pin"] & {
    library_id: string;
    library_version: string;
    library_manifest_hash: string;
  };
  intent: string;
  decision_pin?: ResolvedSfxCue["decision_pin"];
}

export interface AudioRenderPlan {
  version: "audio-render-plan/v1";
  project_id: string;
  strategy: AudioRenderStrategy;
  timeline: {
    path: string;
    version: string;
    content_hash: string;
    duration_frames: number;
    fps: { num: number; den: number };
  };
  inputs: {
    music_cues_path?: string;
    music_cues_content_hash?: string;
    selection_content_hash?: string;
    sfx_cues_path?: string;
    sfx_cues_content_hash?: string;
    sfx_library_manifest_path?: string;
    sfx_library_manifest_hash?: string;
    sound_design_decision_path?: string;
    sound_design_decision_content_hash?: string;
  };
  dialogue: {
    source_track_id: "A1";
    clips: AudioRenderSourceClip[];
    finish_scope: DialogueFinishScope;
    finish_policy?: ResolvedAudioFinishPolicy;
  };
  music: {
    enabled: boolean;
    source_track_id: "A2";
    cues: AudioRenderCue[];
  };
  sfx?: {
    enabled: boolean;
    required: boolean;
    source_track_id: "A3";
    library?: {
      library_id: string;
      library_version: string;
      manifest_path: string;
      manifest_hash: string;
    };
    cues: AudioRenderSfxCue[];
  };
  final_mastering: MasteringDefaults & {
    count: 0 | 1;
    stage: "after_mix" | "not_applied";
  };
  expected_artifacts: {
    dialogue_stem: "raw_dialogue.wav";
    final_mix: "final_mix.wav";
    report: "audio-mix-report.json";
  };
  warnings: string[];
}

export interface ResolveAudioRenderPlanOptions {
  projectDir: string;
  timelinePath: string;
  musicCuesPath?: string;
  sfxCuesPath?: string;
  sourceOverrides?: Record<string, string>;
  packRegistryOptions?: PackRegistryOptions;
  resolveTrackImpl?: (
    musicCues: MusicCuesDoc,
    registryOptions?: PackRegistryOptions,
  ) => AudioRenderResolvedTrack;
  masteringDefaults?: MasteringDefaults;
}

export class AudioRenderPlanError extends Error {
  constructor(
    readonly code:
      | "AUDIO_RENDER_PLAN_INVALID"
      | "AUDIO_RENDER_SOURCE_MISSING"
      | "AUDIO_RENDER_PACK_DRIFT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AudioRenderPlanError";
  }
}

export function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}

export function hashAudioRenderPlan(plan: AudioRenderPlan): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized(plan)))
    .digest("hex")}`;
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `${label} is missing: ${resolved}`,
    );
  }
  return resolved;
}

function resolveA1Source(
  projectDir: string,
  clip: ClipOutput,
  overrides: Record<string, string> | undefined,
  sourceMap: ReturnType<typeof loadSourceMap> | undefined,
): string {
  const explicit = overrides?.[clip.asset_id];
  const mapped = sourceMap?.entryMap.get(clip.asset_id)?.source_locator;
  const metadata = clip.metadata as Record<string, unknown> | undefined;
  const hinted = ["source_path", "source_locator", "local_source_path"]
    .map((key) => metadata?.[key])
    .find((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
  const candidate = explicit ?? mapped ?? hinted;
  if (!candidate) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `A1 clip ${clip.clip_id} has no source for asset ${clip.asset_id}.`,
    );
  }
  return requiredFile(
    path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate),
    `A1 clip ${clip.clip_id}`,
  );
}

function audioPolicyMode(timeline: TimelineIR): "ducking" | "bgm_only" | "original_only" {
  const mode = timeline.provenance?.audio_policy?.mode;
  return mode === "bgm_only" || mode === "original_only" ? mode : "ducking";
}

function timelineDurationFrames(timeline: TimelineIR): number {
  const trackGroups = Object.values(
    timeline.tracks as Record<string, Array<{ clips: ClipOutput[] }>>,
  );
  return trackGroups
    .flatMap((tracks) => tracks ?? [])
    .flatMap((track) => track.clips ?? [])
    .reduce(
      (tail, clip) =>
        Math.max(tail, clip.timeline_in_frame + clip.timeline_duration_frames),
      0,
    );
}

function resolveProductionTrack(
  musicCues: MusicCuesDoc,
  registryOptions?: PackRegistryOptions,
): AudioRenderResolvedTrack {
  const asset = musicCues.music_asset;
  if (!asset.track_id || !asset.full_mix_content_hash) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_cues/v2 requires track_id and full_mix_content_hash.",
    );
  }
  const resolved: ResolvedPinnedBgmTrack = resolveExplicitBgmTrack(
    asset.track_id,
    asset.full_mix_content_hash,
    registryOptions,
  );
  if (!resolved.full_mix_path) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `verified Pack full mix path is unavailable for ${resolved.track_id}.`,
    );
  }
  return {
    track_id: resolved.track_id,
    pack_id: resolved.pack_id,
    pack_version: resolved.pack_version,
    pack_manifest_hash: resolved.manifest_hash,
    full_mix_path: resolved.full_mix_path,
    full_mix_content_hash: resolved.full_mix_ref.content_hash,
    full_mix_size_bytes: resolved.full_mix_ref.size_bytes,
    analysis_content_hash: resolved.analysis_ref.content_hash,
    analysis_size_bytes: resolved.analysis_ref.size_bytes,
    analysis_status: resolved.analysis.status ?? "unavailable",
    duration_us: resolved.duration_us,
  };
}

function mismatch(label: string, expected: unknown, actual: unknown): never {
  throw new AudioRenderPlanError(
    "AUDIO_RENDER_PACK_DRIFT",
    `${label} expected=${String(expected)} actual=${String(actual)}`,
  );
}

function assertMusicAssetPins(
  doc: MusicCuesDoc,
  resolved: AudioRenderResolvedTrack,
): void {
  const asset = doc.music_asset;
  const checks: Array<[string, unknown, unknown]> = [
    ["track_id", asset.track_id, resolved.track_id],
    ["pack_id", asset.pack_id, resolved.pack_id],
    ["pack_version", asset.pack_version, resolved.pack_version],
    ["pack_manifest_hash", asset.pack_manifest_hash, resolved.pack_manifest_hash],
    ["full_mix_content_hash", asset.full_mix_content_hash, resolved.full_mix_content_hash],
    ["full_mix_size_bytes", asset.full_mix_size_bytes, resolved.full_mix_size_bytes],
    ["analysis_content_hash", asset.analysis_content_hash, resolved.analysis_content_hash],
    ["analysis_size_bytes", asset.analysis_size_bytes, resolved.analysis_size_bytes],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) mismatch(label, expected, actual);
  }
  if (asset.analysis_status && asset.analysis_status !== resolved.analysis_status) {
    mismatch("analysis_status", asset.analysis_status, resolved.analysis_status);
  }
  const fullMixPath = requiredFile(resolved.full_mix_path, "verified Pack full mix");
  const actualHash = hashFile(fullMixPath);
  const actualSize = fs.statSync(fullMixPath).size;
  if (actualHash !== resolved.full_mix_content_hash) {
    mismatch("full_mix file hash", resolved.full_mix_content_hash, actualHash);
  }
  if (actualSize !== resolved.full_mix_size_bytes) {
    mismatch("full_mix file size", resolved.full_mix_size_bytes, actualSize);
  }
}

function cueIdFromTimelineClip(clip: ClipOutput): string | undefined {
  const cue = (clip.metadata as Record<string, unknown> | undefined)?.music_cue;
  return cue && typeof cue === "object" && !Array.isArray(cue)
    && typeof (cue as Record<string, unknown>).cue_id === "string"
    ? (cue as Record<string, unknown>).cue_id as string
    : undefined;
}

function sfxCueIdFromTimelineClip(clip: ClipOutput): string | undefined {
  const cue = (clip.metadata as Record<string, unknown> | undefined)?.sfx_cue;
  return cue && typeof cue === "object" && !Array.isArray(cue)
    && typeof (cue as Record<string, unknown>).cue_id === "string"
    ? (cue as Record<string, unknown>).cue_id as string
    : undefined;
}

function assertTimelineSfxCueMatches(
  cue: ResolvedSfxCue,
  timelineClip: ClipOutput | undefined,
  plan: ResolvedSfxCuePlan,
): void {
  if (!timelineClip) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A3 projection for SFX cue ${cue.cue_id} is missing.`,
    );
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["role", "sfx", timelineClip.role],
    ["asset_id", cue.asset_id, timelineClip.asset_id],
    ["timeline_in_frame", cue.timeline_range.in_frame, timelineClip.timeline_in_frame],
    [
      "timeline_duration_frames",
      cue.timeline_range.out_frame - cue.timeline_range.in_frame,
      timelineClip.timeline_duration_frames,
    ],
    ["src_in_us", cue.source_range_us.in_us, timelineClip.src_in_us],
    ["src_out_us", cue.source_range_us.out_us, timelineClip.src_out_us],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        `A3 SFX cue ${cue.cue_id} ${label} expected=${String(expected)} actual=${String(actual)}`,
      );
    }
  }
  const metadata = timelineClip.metadata as Record<string, unknown> | undefined;
  const asset = metadata?.sfx_asset;
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A3 SFX cue ${cue.cue_id} has no sfx_asset pin metadata.`,
    );
  }
  const pins = asset as Record<string, unknown>;
  for (const [label, expected] of [
    ["library_id", plan.library.library_id],
    ["library_version", plan.library.library_version],
    ["library_manifest_hash", plan.library.manifest_hash],
    ["asset_content_hash", cue.asset_pin.asset_content_hash],
    ["asset_size_bytes", cue.asset_pin.asset_size_bytes],
    ["rights_evidence_ref", cue.asset_pin.rights_evidence_ref],
    ["provenance_ref", cue.asset_pin.provenance_ref],
  ] as Array<[string, unknown]>) {
    if (pins[label] !== expected) {
      mismatch(`A3 ${cue.cue_id} ${label}`, expected, pins[label]);
    }
  }
  if (cue.decision_pin) {
    const cueMetadata = metadata?.sfx_cue;
    const projectedPin = cueMetadata
      && typeof cueMetadata === "object"
      && !Array.isArray(cueMetadata)
      ? (cueMetadata as Record<string, unknown>).decision_pin
      : undefined;
    if (
      !projectedPin
      || JSON.stringify(projectedPin) !== JSON.stringify(cue.decision_pin)
    ) {
      mismatch(
        `A3 ${cue.cue_id} decision_pin`,
        JSON.stringify(cue.decision_pin),
        JSON.stringify(projectedPin),
      );
    }
  }
}

function overlapFrames(
  target: { in_frame: number; out_frame: number },
  dialogueClips: AudioRenderSourceClip[],
): number {
  return dialogueClips.reduce((total, clip) => {
    const start = Math.max(target.in_frame, clip.timeline_range.in_frame);
    const end = Math.min(target.out_frame, clip.timeline_range.out_frame);
    return total + Math.max(0, end - start);
  }, 0);
}

function assertTimelineCueMatches(
  cue: MusicCueV2,
  timelineClip: ClipOutput | undefined,
  musicCues: MusicCuesDoc,
): void {
  if (!timelineClip) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A2 projection for cue ${cue.cue_id} is missing.`,
    );
  }
  const expectedDuration =
    cue.timeline_range.out_frame - cue.timeline_range.in_frame;
  const checks: Array<[string, unknown, unknown]> = [
    ["asset_id", musicCues.music_asset.asset_id, timelineClip.asset_id],
    ["timeline_in_frame", cue.timeline_range.in_frame, timelineClip.timeline_in_frame],
    ["timeline_duration_frames", expectedDuration, timelineClip.timeline_duration_frames],
    ["src_in_us", cue.source_range.in_us, timelineClip.src_in_us],
    ["src_out_us", cue.source_range.out_us, timelineClip.src_out_us],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        `A2 cue ${cue.cue_id} ${label} expected=${String(expected)} actual=${String(actual)}`,
      );
    }
  }
  const assetMeta =
    (timelineClip.metadata as Record<string, unknown> | undefined)?.music_asset;
  if (!assetMeta || typeof assetMeta !== "object" || Array.isArray(assetMeta)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A2 cue ${cue.cue_id} has no music_asset pin metadata.`,
    );
  }
  const pins = assetMeta as Record<string, unknown>;
  for (const [label, expected] of [
    ["pack_id", musicCues.music_asset.pack_id],
    ["pack_version", musicCues.music_asset.pack_version],
    ["pack_manifest_hash", musicCues.music_asset.pack_manifest_hash],
    ["full_mix_content_hash", musicCues.music_asset.full_mix_content_hash],
    ["analysis_content_hash", musicCues.music_asset.analysis_content_hash],
  ] as Array<[string, unknown]>) {
    if (pins[label] !== expected) {
      mismatch(`A2 ${cue.cue_id} ${label}`, expected, pins[label]);
    }
  }
}

function resolveDialogueClips(
  projectDir: string,
  timeline: TimelineIR,
  sourceOverrides?: Record<string, string>,
): AudioRenderSourceClip[] {
  const a1Tracks = timeline.tracks.audio.filter((track) => track.track_id === "A1");
  const needsSourceMap = a1Tracks.some((track) =>
    track.clips.some((clip) => !sourceOverrides?.[clip.asset_id])
  );
  const sourceMap = needsSourceMap ? loadSourceMap(projectDir) : undefined;
  return a1Tracks
    .flatMap((track) => track.clips)
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame
      || left.clip_id.localeCompare(right.clip_id, "en")
    )
    .map((clip) => {
      const sourcePath = resolveA1Source(
        projectDir,
        clip,
        sourceOverrides,
        sourceMap,
      );
      const gainRole = clip.role === "nat_sound" ? "nat_sound" : "nat";
      const gain = resolveAudioGainWithFallback(
        clip.audio_policy,
        timeline.audio_mix as AudioMix | undefined,
        gainRole,
      ).gainLinear;
      return {
        track_id: "A1" as const,
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        role: clip.role === "nat_sound"
          ? "nat_sound" as const
          : "dialogue" as const,
        source_path: sourcePath,
        source_content_hash: hashFile(sourcePath),
        source_size_bytes: fs.statSync(sourcePath).size,
        source_range_us: { in_us: clip.src_in_us, out_us: clip.src_out_us },
        timeline_range: {
          in_frame: clip.timeline_in_frame,
          out_frame:
            clip.timeline_in_frame + clip.timeline_duration_frames,
        },
        gain_linear: gain,
      };
    });
}

export function resolveAudioRenderPlan(
  options: ResolveAudioRenderPlanOptions,
): AudioRenderPlan {
  const projectDir = path.resolve(options.projectDir);
  const timelinePath = requiredFile(options.timelinePath, "timeline");
  const timeline = readJson<TimelineIR>(timelinePath);
  if (
    !timeline.project_id
    || !timeline.sequence?.fps_num
    || !timeline.sequence?.fps_den
  ) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "timeline project_id and rational fps are required.",
    );
  }
  const dialogueClips = resolveDialogueClips(
    projectDir,
    timeline,
    options.sourceOverrides,
  );
  const finishPolicy = resolveAudioFinishPolicy(timeline.metadata?.audio_finish);
  const policyMode = audioPolicyMode(timeline);
  const timelineA2Clips = timeline.tracks.audio
    .filter((track) => track.track_id === "A2")
    .flatMap((track) => track.clips);
  const timelineA3Clips = timeline.tracks.audio
    .filter((track) => track.track_id === "A3")
    .flatMap((track) => track.clips);
  const musicCuesPath =
    options.musicCuesPath && fs.existsSync(options.musicCuesPath)
      ? path.resolve(options.musicCuesPath)
      : undefined;
  const musicCues = musicCuesPath
    ? readJson<MusicCuesDoc>(musicCuesPath)
    : undefined;
  const explicitV2 = musicCues?.version === "2.0.0";
  const sfxCuesPath =
    options.sfxCuesPath && fs.existsSync(options.sfxCuesPath)
      ? path.resolve(options.sfxCuesPath)
      : undefined;
  const resolvedSfx = sfxCuesPath && policyMode !== "original_only"
    ? resolveSfxCuePlan({
        projectDir,
        timeline,
        cuesPath: sfxCuesPath,
      })
    : undefined;
  const warnings: string[] = [];

  let strategy: AudioRenderStrategy;
  let finishScope: DialogueFinishScope;
  let musicEnabled = false;
  let cues: AudioRenderCue[] = [];
  let sfxCues: AudioRenderSfxCue[] = [];
  if (policyMode === "original_only") {
    strategy = "original_passthrough";
    finishScope = "none_original_passthrough";
    if (timelineA2Clips.length > 0 || musicCues || timelineA3Clips.some(sfxCueIdFromTimelineClip) || sfxCuesPath) {
      warnings.push(
        "original_only disables formal A2/A3 rendering until an explicit project copy changes the audio policy.",
      );
    }
  } else if (explicitV2 && musicCues) {
    const validation = validateMusicCues(musicCues);
    if (!validation.valid) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        validation.errors.join("; "),
      );
    }
    if (musicCues.project_id !== timeline.project_id) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_cues project_id does not match timeline project_id.",
      );
    }
    if (musicCues.base_timeline_version !== timeline.version) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_cues base_timeline_version is stale.",
      );
    }
    if (
      musicCues.timeline_fps?.num !== timeline.sequence.fps_num
      || musicCues.timeline_fps?.den !== timeline.sequence.fps_den
    ) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_cues rational fps does not match timeline.",
      );
    }
    const resolved = (options.resolveTrackImpl ?? resolveProductionTrack)(
      musicCues,
      options.packRegistryOptions,
    );
    assertMusicAssetPins(musicCues, resolved);
    const byCueId = new Map(
      timelineA2Clips.map((clip) => [cueIdFromTimelineClip(clip), clip]),
    );
    cues = (musicCues.cues as MusicCueV2[])
      .map((cue) => {
        assertTimelineCueMatches(cue, byCueId.get(cue.cue_id), musicCues);
        if (cue.source_range.out_us > resolved.duration_us) {
          throw new AudioRenderPlanError(
            "AUDIO_RENDER_PLAN_INVALID",
            `cue ${cue.cue_id} exceeds verified source duration.`,
          );
        }
        return {
          cue_id: cue.cue_id,
          track_id: cue.track_id,
          source_path: path.resolve(resolved.full_mix_path),
          source_range_us: { ...cue.source_range },
          timeline_range: { ...cue.timeline_range },
          semantic_anchor: { ...cue.semantic_anchor },
          section: cue.section,
          phase: cue.phase,
          applied: {
            base_gain_db: cue.ducking.base_gain_db,
            duck_gain_db: cue.ducking.duck_gain_db,
            fade_in_ms: cue.fade_in_ms,
            fade_out_ms: cue.fade_out_ms,
            attack_ms: cue.ducking.attack_ms,
            release_ms: cue.ducking.release_ms,
          },
          pins: {
            pack_id: resolved.pack_id,
            pack_version: resolved.pack_version,
            pack_manifest_hash: resolved.pack_manifest_hash,
            full_mix_content_hash: resolved.full_mix_content_hash,
            full_mix_size_bytes: resolved.full_mix_size_bytes,
            analysis_content_hash: resolved.analysis_content_hash,
            analysis_size_bytes: resolved.analysis_size_bytes,
            analysis_status: resolved.analysis_status,
          },
        };
      })
      .sort((left, right) =>
        left.timeline_range.in_frame - right.timeline_range.in_frame
        || left.cue_id.localeCompare(right.cue_id, "en")
      );
    strategy = "explicit_music_cues_v2";
    finishScope = finishPolicy ? "a1_only" : "none";
    musicEnabled = true;
    warnings.push(...(musicCues.warnings ?? []));
  } else if (timelineA2Clips.length > 0 || musicCues) {
    strategy = "legacy_embedded_bgm";
    finishScope = "none_mixed_legacy";
    warnings.push(
      "Legacy embedded BGM remains on the compatibility path and may not be passed through dialogue finishing.",
    );
  } else {
    strategy = "dialogue_only";
    finishScope = finishPolicy ? "a1_only" : "none";
  }

  if (resolvedSfx) {
    if (strategy === "legacy_embedded_bgm") {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "formal A3 SFX cannot share the legacy embedded-BGM compatibility path.",
      );
    }
    const byCueId = new Map(
      timelineA3Clips.map((clip) => [sfxCueIdFromTimelineClip(clip), clip]),
    );
    sfxCues = resolvedSfx.cues.map((cue) => {
      assertTimelineSfxCueMatches(cue, byCueId.get(cue.cue_id), resolvedSfx);
      return {
        cue_id: cue.cue_id,
        semantic_role: cue.semantic_role,
        asset_id: cue.asset_id,
        source_path: cue.source_path,
        source_range_us: { ...cue.source_range_us },
        timeline_range: { ...cue.timeline_range },
        trigger_frame: cue.trigger_frame,
        duration_frames: cue.duration_frames,
        dialogue_overlap_frames: overlapFrames(cue.timeline_range, dialogueClips),
        applied: {
          gain_db: cue.gain_db,
          fade_in_ms: cue.fade_in_ms,
          fade_out_ms: cue.fade_out_ms,
          duck_group: cue.duck_group,
          duck_gain_db: cue.ducking.duck_gain_db,
          attack_ms: cue.ducking.attack_ms,
          release_ms: cue.ducking.release_ms,
        },
        tail_processing: { ...cue.tail_processing },
        pins: {
          ...cue.asset_pin,
          library_id: resolvedSfx.library.library_id,
          library_version: resolvedSfx.library.library_version,
          library_manifest_hash: resolvedSfx.library.manifest_hash,
        },
        intent: cue.intent,
        ...(cue.decision_pin
          ? { decision_pin: structuredClone(cue.decision_pin) }
          : {}),
      };
    });
    strategy = musicEnabled
      ? "explicit_music_and_sfx_cues_v1"
      : "explicit_sfx_cues_v1";
    finishScope = finishPolicy ? "a1_only" : "none";
  }

  const mastering = options.masteringDefaults ?? DEFAULT_MASTERING;
  const masteringCount = strategy === "original_passthrough" ? 0 : 1;
  return {
    version: "audio-render-plan/v1",
    project_id: timeline.project_id,
    strategy,
    timeline: {
      path: timelinePath,
      version: timeline.version,
      content_hash: hashFile(timelinePath),
      duration_frames: timelineDurationFrames(timeline),
      fps: {
        num: timeline.sequence.fps_num,
        den: timeline.sequence.fps_den,
      },
    },
    inputs: {
      ...(musicCuesPath
        ? {
            music_cues_path: musicCuesPath,
            music_cues_content_hash: hashFile(musicCuesPath),
          }
        : {}),
      ...(musicCues?.selection_ref?.content_hash
        ? { selection_content_hash: musicCues.selection_ref.content_hash }
        : {}),
      ...(resolvedSfx
        ? {
            sfx_cues_path: resolvedSfx.cues_path,
            sfx_cues_content_hash: resolvedSfx.cues_content_hash,
            sfx_library_manifest_path: resolvedSfx.library.manifest_path,
            sfx_library_manifest_hash: resolvedSfx.library.manifest_hash,
            ...(resolvedSfx.decision_ref
              ? {
                  sound_design_decision_path:
                    resolvedSfx.decision_ref.resolved_path,
                  sound_design_decision_content_hash:
                    resolvedSfx.decision_ref.content_hash,
                }
              : {}),
          }
        : {}),
    },
    dialogue: {
      source_track_id: "A1",
      clips: dialogueClips,
      finish_scope: finishScope,
      ...(finishScope === "a1_only" && finishPolicy
        ? { finish_policy: finishPolicy }
        : {}),
    },
    music: {
      enabled: musicEnabled,
      source_track_id: "A2",
      cues,
    },
    ...(resolvedSfx
      ? {
          sfx: {
            enabled: sfxCues.length > 0,
            required: resolvedSfx.required,
            source_track_id: "A3" as const,
            library: {
              library_id: resolvedSfx.library.library_id,
              library_version: resolvedSfx.library.library_version,
              manifest_path: resolvedSfx.library.manifest_path,
              manifest_hash: resolvedSfx.library.manifest_hash,
            },
            cues: sfxCues,
          },
        }
      : {}),
    final_mastering: {
      ...mastering,
      count: masteringCount,
      stage: masteringCount === 1 ? "after_mix" : "not_applied",
    },
    expected_artifacts: {
      dialogue_stem: "raw_dialogue.wav",
      final_mix: "final_mix.wav",
      report: "audio-mix-report.json",
    },
    warnings: [...new Set(warnings)],
  };
}
