/**
 * RenderSpec — single source of truth for preview and final render composition.
 *
 * Normalizes TimelineIR + source_map into a render-ready specification.
 * Both preview and final render consume the same RenderSpec; only the
 * encode profile differs.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  type CaptionStylePreset,
  DEFAULT_CAPTION_STYLE_PRESET,
} from "./caption-style-tokens.js";
import {
  DIALOGUE_CUT_FADE_DEFAULT_MS,
  TALKING_HEAD_PACING_SKILL_ID,
} from "./dialogue-cut-fade.js";
import {
  appendAudioGainWarning,
  resolveAudioGain,
  resolveAudioGainWithFallback,
  type AudioGainProvenance,
  type GainUnit,
} from "./audio-gain.js";

// ── Sub-types ────────────────────────────────────────────────────────

export interface RenderVideoClip {
  clipId: string;
  assetId: string;
  sourcePath: string;
  timelineInFrame: number;
  durationFrames: number;
  sourceInSec: number;
  sourceOutSec: number;
  transform: {
    mode: "cover";
    zoom: number;
    anchor: "center";
    crop?: { x: number; y: number; width: number; height: number };
    position?: { x: number; y: number };
  };
  effects: RenderEffectSpec[];
}

export type TransitionType =
  | "cut"
  | "crossfade"
  | "fade_to_black"
  | "dip_to_white"
  | "match_cut_soft"
  | "j_cut"
  | "l_cut";

export interface RenderTransition {
  fromClipId: string;
  toClipId: string;
  type: TransitionType;
  durationFrames: number;
  /** j_cut: incoming audio leads video cut by this many seconds */
  audioLeadSec?: number;
  /** l_cut: outgoing audio trails video cut by this many seconds */
  audioTrailSec?: number;
  params?: Record<string, unknown>;
}

export interface RenderTextCue {
  id: string;
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface RenderAudioClip {
  clipId: string;
  assetId: string;
  sourcePath: string;
  trackId: string;
  role?: string;
  timelineInFrame: number;
  durationFrames: number;
  sourceInSec: number;
  sourceOutSec: number;
  /** Canonical gain in dB. Renderers must not reinterpret timeline values. */
  gainDb: number;
  /** Canonical amplitude multiplier; preserves exact mute at zero. */
  gainLinear: number;
  gainProvenance: AudioGainProvenance;
  fadeInFrames: number;
  fadeOutFrames: number;
}

export interface RenderBgmSpec {
  assetId: string;
  sourcePath: string;
  /** Canonical gain in dB. Renderers must not reinterpret timeline values. */
  gainDb: number;
  /** Canonical amplitude multiplier; preserves exact mute at zero. */
  gainLinear: number;
  gainProvenance: AudioGainProvenance;
  fadeInFrames: number;
  fadeOutFrames: number;
  /** Ducking level in dB (negative) applied to BGM during dialogue */
  duckMusicDb?: number;
}

export interface MasteringDefaults {
  targetLufs: number;
  truePeakDbtp: number;
  lra: number;
}

/**
 * Phase 5: Effect chain support.
 *
 * P0 supports a small set of ffmpeg-native filters only:
 * - eq:          full eq= filter (brightness/contrast/saturation/gamma)
 * - curves:      ffmpeg curves filter (preset name OR per-channel control points)
 * - brightness:  shorthand → emitted as eq=brightness=...
 * - contrast:    shorthand → emitted as eq=contrast=...
 * - saturation:  shorthand → emitted as eq=saturation=...
 * - none:        no-op (lets timelines carry placeholder effects)
 *
 * Unsupported effect types are degraded (skipped) and recorded in
 * RenderSpec.warnings — they MUST NOT raise an error during build.
 */
export type RenderEffectType =
  | "none"
  | "eq"
  | "curves"
  | "brightness"
  | "contrast"
  | "saturation";

export interface RenderEffectSpec {
  /** Effect type. Unknown strings degrade to a no-op with a warning. */
  type: RenderEffectType | string;
  /**
   * Effect parameters. Most filters use numeric scalars; curves can carry
   * a string `preset` field. Unknown keys are passed through verbatim.
   */
  params: Record<string, number | string>;
}

/** P0 effect allow-list. */
export const SUPPORTED_EFFECT_TYPES: ReadonlySet<string> = new Set<RenderEffectType>([
  "none",
  "eq",
  "curves",
  "brightness",
  "contrast",
  "saturation",
]);

/** Type guard: is the given string a P0-supported effect type? */
export function isSupportedEffectType(t: string): t is RenderEffectType {
  return SUPPORTED_EFFECT_TYPES.has(t);
}

// ── RenderSpec ───────────────────────────────────────────────────────

export interface RenderSpec {
  version: "1";
  /** Bump when renderer semantics change so persisted exact-preview caches invalidate. */
  rendererContractVersion: "6";
  timelineRevision: string;
  renderSpecHash: string;
  sequence: {
    fps: number;
    fpsNum: number;
    fpsDen: number;
    width: number;
    height: number;
    sampleRate: number;
    outputAspectRatio?: string;
    letterboxPolicy?: "none" | "pillarbox" | "letterbox";
  };
  video: {
    clips: RenderVideoClip[];
    transitions: RenderTransition[];
  };
  text: {
    speechCaptions: RenderTextCue[];
    overlays: RenderTextCue[];
    stylePreset: CaptionStylePreset;
  };
  audio: {
    dialogueClips: RenderAudioClip[];
    dialogue_cut_fade_ms: number;
    bgm?: RenderBgmSpec;
    mastering: MasteringDefaults;
  };
  effects: RenderEffectSpec[];
  /** Build-time warnings (degrade notices, missing assets, etc.) */
  warnings: string[];
}

// ── PreviewArtifactMeta ──────────────────────────────────────────────

export interface PreviewArtifactMeta {
  renderSpecHash: string;
  timelineRevision: string;
  sequence: {
    width: number;
    height: number;
    fps: number;
    fpsNum: number;
    fpsDen: number;
  };
  generatedAt: string;
  status: "ready" | "rendering" | "error";
  warnings: string[];
  videoPath: string;
}

// ── Minimal timeline types for the builder (avoids importing client types) ──

interface MinimalClip {
  clip_id: string;
  asset_id: string;
  role?: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  audio_policy?: {
    gain_unit?: GainUnit;
    duck_music_db?: number;
    nat_sound_gain?: number;
    nat_gain?: number;
    bgm_gain?: number;
    fade_in_frames?: number;
    fade_out_frames?: number;
    nat_sound_fade_in_frames?: number;
    nat_sound_fade_out_frames?: number;
    bgm_fade_in_frames?: number;
    bgm_fade_out_frames?: number;
  };
  metadata?: Record<string, unknown>;
}

interface MinimalTrack {
  track_id: string;
  kind: string;
  clips: MinimalClip[];
}

interface MinimalSequence {
  fps_num: number;
  fps_den: number;
  width: number;
  height: number;
  sample_rate?: number;
  output_aspect_ratio?: string;
  letterbox_policy?: "none" | "pillarbox" | "letterbox";
}

interface MinimalTransition {
  from_clip_id: string;
  to_clip_id: string;
  transition_type: string;
  transition_frames?: number;
  transition_params?: Record<string, unknown>;
}

interface MinimalAudioMix {
  gain_unit?: GainUnit;
  nat_sound_gain?: number;
  bgm_asset_id?: string;
  bgm_gain?: number;
  duck_music_db?: number;
  bgm_fade_in_frames?: number;
  bgm_fade_out_frames?: number;
}

interface MinimalTimeline {
  sequence: MinimalSequence;
  tracks: {
    video: MinimalTrack[];
    audio: MinimalTrack[];
    caption?: MinimalTrack[];
    overlay?: MinimalTrack[];
  };
  transitions?: MinimalTransition[];
  audio_mix?: MinimalAudioMix;
}

// ── Caption approval types ──────────────────────────────────────────

interface CaptionApprovalCue {
  id?: string;
  text: string;
  start_frame: number;
  end_frame: number;
}

/** Canonical shape per schemas/caption-approval.schema.json. */
interface CanonicalSpeechCaption {
  caption_id?: string;
  text: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
}

interface CaptionApprovalDoc {
  /** Canonical field (caption-approval.schema.json) — preferred. */
  speech_captions?: CanonicalSpeechCaption[];
  /** Legacy editor-draft shape, kept for backward compatibility. */
  cues?: CaptionApprovalCue[];
  style_preset?: CaptionStylePreset;
}

// ── Builder ──────────────────────────────────────────────────────────

export type AssetPathResolver = (assetId: string) => string | undefined;

export interface BuildRenderSpecOptions {
  captionStylePreset?: CaptionStylePreset;
  /** Path to caption_approval.json. If provided and exists, overrides caption track cues. */
  captionApprovalPath?: string;
}

/**
 * Build a RenderSpec from a saved timeline + source map path resolver.
 *
 * Phase 1 scope:
 * - Video: trim only (no zoom/crop/position — always cover@1x center)
 * - Transitions: all degrade to cut (empty array)
 * - Captions: extracted from caption tracks if present (or from captionApprovalPath)
 * - Audio: source pass-through with per-clip gain
 * - Effects: empty
 */
export function buildRenderSpec(
  timeline: MinimalTimeline,
  timelineRevision: string,
  resolveAssetPath: AssetPathResolver,
  captionStylePresetOrOptions?: CaptionStylePreset | BuildRenderSpecOptions,
): RenderSpec {
  // Support both old signature (preset only) and new options object
  let captionStylePreset: CaptionStylePreset | undefined;
  let captionApprovalPath: string | undefined;
  if (captionStylePresetOrOptions && typeof captionStylePresetOrOptions === 'object' && 'captionApprovalPath' in captionStylePresetOrOptions) {
    captionStylePreset = captionStylePresetOrOptions.captionStylePreset;
    captionApprovalPath = captionStylePresetOrOptions.captionApprovalPath;
  } else {
    captionStylePreset = captionStylePresetOrOptions as CaptionStylePreset | undefined;
  }
  const fps =
    timeline.sequence.fps_num / (timeline.sequence.fps_den || 1);
  const fpsNum = timeline.sequence.fps_num;
  const fpsDen = timeline.sequence.fps_den || 1;
  const { width, height } = timeline.sequence;
  const sampleRate = timeline.sequence.sample_rate ?? 48000;
  const dialogueCutFadeMs = timelineHasAppliedSkill(
    timeline,
    TALKING_HEAD_PACING_SKILL_ID,
  )
    ? DIALOGUE_CUT_FADE_DEFAULT_MS
    : 0;

  // ── Video clips ──
  const videoClips: RenderVideoClip[] = [];
  const warnings: string[] = [];

  for (const track of timeline.tracks.video) {
    for (const clip of sortClips(track.clips)) {
      const sourcePath = resolveAssetPath(clip.asset_id);
      if (!sourcePath) {
        warnings.push(`Missing source for asset ${clip.asset_id}`);
        continue;
      }
      // Phase 2: Map metadata.zoom to transform.zoom (Section 9.1 / 7.4)
      const metaZoom =
        typeof clip.metadata?.zoom === "number" ? clip.metadata.zoom : 1;
      const metaCrop = clip.metadata?.crop as
        | { x: number; y: number; width: number; height: number }
        | undefined;
      const metaPosition = clip.metadata?.position as
        | { x: number; y: number }
        | undefined;

      // Phase 5: Effect chain (Section 9.5)
      // Read clip.metadata.render.effects[] (preferred) and skip
      // unsupported types with a warning. The order is preserved.
      const renderMeta = clip.metadata?.render as
        | { effects?: unknown }
        | undefined;
      const effects: RenderEffectSpec[] = [];
      if (renderMeta?.effects && Array.isArray(renderMeta.effects)) {
        for (const raw of renderMeta.effects) {
          if (!raw || typeof raw !== "object") continue;
          const r = raw as { type?: unknown; params?: unknown };
          if (typeof r.type !== "string") continue;
          if (!isSupportedEffectType(r.type)) {
            warnings.push(
              `Effect '${r.type}' on clip ${clip.clip_id} is unsupported; skipped`,
            );
            continue;
          }
          if (r.type === "none") continue;
          const params: Record<string, number | string> = {};
          if (r.params && typeof r.params === "object") {
            for (const [k, v] of Object.entries(
              r.params as Record<string, unknown>,
            )) {
              if (typeof v === "number" || typeof v === "string") {
                params[k] = v;
              }
            }
          }
          effects.push({ type: r.type, params });
        }
      }

      videoClips.push({
        clipId: clip.clip_id,
        assetId: clip.asset_id,
        sourcePath,
        timelineInFrame: clip.timeline_in_frame,
        durationFrames: clip.timeline_duration_frames,
        sourceInSec: clip.src_in_us / 1_000_000,
        sourceOutSec: clip.src_out_us / 1_000_000,
        transform: {
          mode: "cover",
          zoom: metaZoom,
          anchor: "center",
          ...(metaCrop ? { crop: metaCrop } : {}),
          ...(metaPosition ? { position: metaPosition } : {}),
        },
        effects,
      });
    }
  }

  // Sort all video clips by timeline position
  videoClips.sort((a, b) => a.timelineInFrame - b.timelineInFrame);

  // ── Audio clips ──
  const audioClips: RenderAudioClip[] = [];

  for (const track of timeline.tracks.audio) {
    for (const clip of sortClips(track.clips)) {
      const sourcePath = resolveAssetPath(clip.asset_id);
      if (!sourcePath) {
        warnings.push(`Missing audio source for asset ${clip.asset_id}`);
        continue;
      }
      const gain = resolveAudioGainWithFallback(
        clip.audio_policy,
        timeline.audio_mix,
        clip.role === "bgm" || clip.role === "music" || track.track_id === "A2"
          ? "bgm"
          : clip.role === "nat_sound"
            ? "nat_sound"
            : "nat",
      );
      appendAudioGainWarning(warnings, gain.warning);
      audioClips.push({
        clipId: clip.clip_id,
        assetId: clip.asset_id,
        sourcePath,
        trackId: track.track_id,
        role: clip.role,
        timelineInFrame: clip.timeline_in_frame,
        durationFrames: clip.timeline_duration_frames,
        sourceInSec: clip.src_in_us / 1_000_000,
        sourceOutSec: clip.src_out_us / 1_000_000,
        gainDb: gain.gainDb,
        gainLinear: gain.gainLinear,
        gainProvenance: gain.provenance,
        fadeInFrames: clip.audio_policy?.nat_sound_fade_in_frames
          ?? clip.audio_policy?.bgm_fade_in_frames
          ?? clip.audio_policy?.fade_in_frames
          ?? 0,
        fadeOutFrames: clip.audio_policy?.nat_sound_fade_out_frames
          ?? clip.audio_policy?.bgm_fade_out_frames
          ?? clip.audio_policy?.fade_out_frames
          ?? 0,
      });
    }
  }

  audioClips.sort((a, b) => a.timelineInFrame - b.timelineInFrame);

  // ── Caption cues ──
  // MAJOR-4: If captionApprovalPath is provided and exists, use it.
  // Otherwise fall back to timeline caption tracks (existing behavior).
  const speechCaptions: RenderTextCue[] = [];
  let captionApprovalLoaded = false;
  if (captionApprovalPath) {
    try {
      if (fs.existsSync(captionApprovalPath)) {
        const doc: CaptionApprovalDoc = JSON.parse(
          fs.readFileSync(captionApprovalPath, "utf-8"),
        );
        // Canonical shape first: the caption pipeline and final render read
        // speech_captions, so the exact preview must honor the same field.
        if (Array.isArray(doc.speech_captions)) {
          for (const cap of doc.speech_captions) {
            speechCaptions.push({
              id: cap.caption_id ?? `cap-${cap.timeline_in_frame}`,
              text: cap.text,
              startFrame: cap.timeline_in_frame,
              endFrame: cap.timeline_in_frame + cap.timeline_duration_frames,
            });
          }
          captionApprovalLoaded = true;
          if (doc.style_preset) {
            captionStylePreset = doc.style_preset;
          }
        } else if (Array.isArray(doc.cues)) {
          for (const cue of doc.cues) {
            speechCaptions.push({
              id: cue.id ?? `cap-${cue.start_frame}`,
              text: cue.text,
              startFrame: cue.start_frame,
              endFrame: cue.end_frame,
            });
          }
          captionApprovalLoaded = true;
          // Override style preset from approval doc if present
          if (doc.style_preset) {
            captionStylePreset = doc.style_preset;
          }
        }
      }
    } catch {
      // Failed to load caption_approval — fall through to timeline tracks
    }
  }
  if (!captionApprovalLoaded && timeline.tracks.caption) {
    for (const track of timeline.tracks.caption) {
      for (const clip of sortClips(track.clips)) {
        const text =
          (clip.metadata?.text as string) ??
          (clip.metadata?.caption as string) ??
          clip.clip_id;
        speechCaptions.push({
          id: clip.clip_id,
          text,
          startFrame: clip.timeline_in_frame,
          endFrame: clip.timeline_in_frame + clip.timeline_duration_frames,
        });
      }
    }
  }

  // ── Overlay cues ──
  const overlays: RenderTextCue[] = [];
  if (timeline.tracks.overlay) {
    for (const track of timeline.tracks.overlay) {
      for (const clip of sortClips(track.clips)) {
        const text =
          ((clip.metadata?.overlay as { text?: unknown } | undefined)
            ?.text as string) ??
          (clip.metadata?.text as string) ??
          (clip.metadata?.overlay_text as string) ??
          clip.clip_id;
        overlays.push({
          id: clip.clip_id,
          text,
          startFrame: clip.timeline_in_frame,
          endFrame: clip.timeline_in_frame + clip.timeline_duration_frames,
        });
      }
    }
  }

  // ── Transitions (Phase 4) ──
  const SUPPORTED_TRANSITIONS: ReadonlySet<string> = new Set<TransitionType>([
    "cut", "crossfade", "fade_to_black", "dip_to_white", "match_cut_soft", "j_cut", "l_cut",
  ]);
  function isSupportedTransition(t: string): t is TransitionType {
    return SUPPORTED_TRANSITIONS.has(t);
  }

  const renderTransitions: RenderTransition[] = [];
  if (timeline.transitions) {
    for (const t of timeline.transitions) {
      let type: TransitionType;
      if (isSupportedTransition(t.transition_type)) {
        type = t.transition_type;
      } else {
        warnings.push(
          `Transition ${t.transition_type} (${t.from_clip_id}→${t.to_clip_id}) degraded to cut`,
        );
        type = "cut";
      }
      // Normalize duration: prefer transition_frames, fallback to crossfade_sec
      let durationFrames = t.transition_frames ?? 0;
      if (
        durationFrames === 0 &&
        t.transition_params?.crossfade_sec !== undefined
      ) {
        durationFrames = Math.round(
          (t.transition_params.crossfade_sec as number) * fps,
        );
      }
      // cut has 0 duration
      if (type === "cut") durationFrames = 0;

      // MAJOR-1: Extract audio overlap for j_cut / l_cut
      let audioLeadSec: number | undefined;
      let audioTrailSec: number | undefined;
      if (type === "j_cut") {
        audioLeadSec =
          (t.transition_params?.audio_lead_sec as number | undefined) ??
          (t.transition_params?.audio_overlap_sec as number | undefined) ??
          (durationFrames > 0 ? durationFrames / fps : undefined);
      } else if (type === "l_cut") {
        audioTrailSec =
          (t.transition_params?.audio_trail_sec as number | undefined) ??
          (t.transition_params?.audio_overlap_sec as number | undefined) ??
          (durationFrames > 0 ? durationFrames / fps : undefined);
      }

      renderTransitions.push({
        fromClipId: t.from_clip_id,
        toClipId: t.to_clip_id,
        type,
        durationFrames,
        ...(audioLeadSec !== undefined ? { audioLeadSec } : {}),
        ...(audioTrailSec !== undefined ? { audioTrailSec } : {}),
        ...(t.transition_params ? { params: t.transition_params } : {}),
      });
    }
  }

  // ── BGM (Phase 4) ──
  let bgmSpec: RenderBgmSpec | undefined;
  if (timeline.audio_mix?.bgm_asset_id) {
    const bgmPath = resolveAssetPath(timeline.audio_mix.bgm_asset_id);
    if (bgmPath) {
      const bgmPolicy = timeline.audio_mix.bgm_gain === undefined
        ? { ...timeline.audio_mix, gain_unit: "linear" as const, bgm_gain: 0.25 }
        : timeline.audio_mix;
      const bgmGain = resolveAudioGain(bgmPolicy, "bgm");
      appendAudioGainWarning(warnings, bgmGain.warning);
      bgmSpec = {
        assetId: timeline.audio_mix.bgm_asset_id,
        sourcePath: bgmPath,
        gainDb: bgmGain.gainDb,
        gainLinear: bgmGain.gainLinear,
        gainProvenance: bgmGain.provenance,
        fadeInFrames: timeline.audio_mix.bgm_fade_in_frames ?? 0,
        fadeOutFrames: timeline.audio_mix.bgm_fade_out_frames ?? 0,
        duckMusicDb: timeline.audio_mix.duck_music_db,
      };
    } else {
      warnings.push(
        `Missing BGM source for asset ${timeline.audio_mix.bgm_asset_id}`,
      );
    }
  }

  // ── Assemble spec (without hash) ──
  const spec: RenderSpec = {
    version: "1",
    rendererContractVersion: "6",
    timelineRevision,
    renderSpecHash: "", // computed below
    sequence: {
      fps,
      fpsNum,
      fpsDen,
      width,
      height,
      sampleRate,
      outputAspectRatio: timeline.sequence.output_aspect_ratio,
      letterboxPolicy: timeline.sequence.letterbox_policy,
    },
    video: {
      clips: videoClips,
      transitions: renderTransitions,
    },
    text: {
      speechCaptions,
      overlays,
      stylePreset: captionStylePreset ?? DEFAULT_CAPTION_STYLE_PRESET,
    },
    audio: {
      dialogueClips: audioClips,
      dialogue_cut_fade_ms: dialogueCutFadeMs,
      ...(bgmSpec ? { bgm: bgmSpec } : {}),
      mastering: {
        targetLufs: -16,
        truePeakDbtp: -1.5,
        lra: 7,
      },
    },
    effects: [],
    warnings,
  };

  spec.renderSpecHash = computeRenderSpecHash(spec);
  return spec;
}

function timelineHasAppliedSkill(
  timeline: MinimalTimeline,
  skillId: string,
): boolean {
  const tracks: MinimalTrack[] = [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
    ...(timeline.tracks.caption ?? []),
    ...(timeline.tracks.overlay ?? []),
  ];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clipHasAppliedSkill(clip, skillId)) return true;
    }
  }
  return false;
}

function clipHasAppliedSkill(clip: MinimalClip, skillId: string): boolean {
  const editorial = clip.metadata?.editorial;
  if (!editorial || typeof editorial !== "object") return false;
  const appliedSkills = (editorial as { applied_skills?: unknown }).applied_skills;
  return Array.isArray(appliedSkills) && appliedSkills.includes(skillId);
}

// ── Hash ──────────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash for a RenderSpec.
 * Ignores the `renderSpecHash` field itself to avoid circularity.
 */
export function computeRenderSpecHash(spec: RenderSpec): string {
  const { renderSpecHash: _, warnings: _w, ...rest } = spec;
  const json = JSON.stringify(rest, null, 0);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

// ── Helpers ──────────────────────────────────────────────────────────

function sortClips<T extends { timeline_in_frame: number; clip_id: string }>(
  clips: T[],
): T[] {
  return [...clips].sort(
    (a, b) =>
      a.timeline_in_frame - b.timeline_in_frame ||
      a.clip_id.localeCompare(b.clip_id),
  );
}
