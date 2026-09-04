import * as fs from "node:fs";
import * as path from "node:path";

import {
  AudioRenderPlanError,
  resolveAudioRenderPlan,
  type AudioRenderPlan,
  type ResolveAudioRenderPlanOptions,
} from "./render-plan.js";

export interface ResolveSharedAudioRenderPlanOptions
  extends Omit<ResolveAudioRenderPlanOptions, "musicCuesPath" | "sfxCuesPath"> {
  musicCuesPath?: string;
  sfxCuesPath?: string;
  resolvePlanImpl?: typeof resolveAudioRenderPlan;
}

function timelinePinnedAudio(timelinePath: string): {
  a2: boolean;
  a3: boolean;
  a3Ambient: boolean;
  a3Unsupported: boolean;
  musicMaster: boolean;
  audioProfileRef?: string;
} {
  if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
    return { a2: false, a3: false, a3Ambient: false, a3Unsupported: false, musicMaster: false };
  }
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as {
    metadata?: Record<string, unknown>;
    provenance?: { music_master?: unknown; audio_policy?: { mode?: unknown; music_master?: unknown } };
    tracks?: {
      audio?: Array<{
        track_id?: unknown;
        clips?: Array<{ role?: unknown; audio_role?: unknown; metadata?: Record<string, unknown> }>;
      }>;
    };
  };
  const musicMaster = timeline.provenance?.audio_policy?.mode === "music_master"
    || timeline.provenance?.audio_policy?.music_master !== undefined
    || timeline.provenance?.music_master !== undefined
    || timeline.metadata?.music_master !== undefined;
  if (timeline.provenance?.audio_policy?.mode === "original_only") {
    return {
      a2: false,
      a3: false,
      a3Ambient: false,
      a3Unsupported: false,
      musicMaster,
      audioProfileRef: profileRef(timeline),
    };
  }
  const a2 = (timeline.tracks?.audio ?? [])
    .filter((track) => track.track_id === "A2")
    .flatMap((track) => track.clips ?? [])
    .some((clip) => {
      const cue = clip.metadata?.music_cue as Record<string, unknown> | undefined;
      const asset = clip.metadata?.music_asset as Record<string, unknown> | undefined;
      return typeof cue?.cue_id === "string"
        && typeof asset?.pack_manifest_hash === "string"
        && typeof asset?.full_mix_content_hash === "string";
    });
  const a3Clips = (timeline.tracks?.audio ?? [])
    .filter((track) => track.track_id === "A3")
    .flatMap((track) => track.clips ?? []);
  const a3 = a3Clips.some((clip) => {
      const cue = clip.metadata?.sfx_cue as Record<string, unknown> | undefined;
      const asset = clip.metadata?.sfx_asset as Record<string, unknown> | undefined;
      return typeof cue?.cue_id === "string"
        && typeof asset?.library_manifest_hash === "string"
        && typeof asset?.asset_content_hash === "string";
    });
  const a3Ambient = a3Clips.some((clip) => {
    const metadata = clip.metadata ?? {};
    const formal = Boolean(metadata.sfx_cue || metadata.sfx_asset || clip.audio_role === "sfx" || clip.role === "sfx");
    return !formal && (clip.audio_role === "ambient" || clip.role === "ambient" || metadata.audio_semantic_role === "ambient" || metadata.authored_ambient === true);
  });
  const a3Unsupported = a3Clips.some((clip) => {
    const metadata = clip.metadata ?? {};
    const formal = Boolean(metadata.sfx_cue || metadata.sfx_asset || clip.audio_role === "sfx" || clip.role === "sfx");
    const ambient = !formal && (clip.audio_role === "ambient" || clip.role === "ambient" || metadata.audio_semantic_role === "ambient" || metadata.authored_ambient === true);
    return !ambient;
  });
  return { a2, a3, a3Ambient, a3Unsupported, musicMaster, audioProfileRef: profileRef(timeline) };
}

function profileRef(timeline: {
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}): string | undefined {
  const value = timeline.metadata?.audio_delivery_profile_ref
    ?? timeline.provenance?.audio_delivery_profile_ref;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).ref === "string") {
    return (value as Record<string, unknown>).ref as string;
  }
  return undefined;
}

/**
 * Resolve the shared executor route only for music-cues/v2 and/or formal
 * sfx-cues/v1. Legacy and original_only projects remain on established paths.
 * Reading and pin validation happen before any media write or encode.
 */
export function resolveSharedAudioRenderPlan(
  options: ResolveSharedAudioRenderPlanOptions,
): AudioRenderPlan | undefined {
  const pinned = timelinePinnedAudio(options.timelinePath);
  let musicCuesPath: string | undefined;
  if (!options.musicCuesPath) {
    if (pinned.a2) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "hash-pinned A2 requires music-cues/v2; refusing the legacy mixed-audio path.",
      );
    }
  } else {
    const candidate = path.resolve(options.musicCuesPath);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      if (pinned.a2) {
        throw new AudioRenderPlanError(
          "AUDIO_RENDER_PLAN_INVALID",
          "hash-pinned A2 requires an existing music-cues/v2 artifact.",
        );
      }
    } else {
      const header = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (header.version !== "2.0.0") {
        if (pinned.a2) {
          throw new AudioRenderPlanError(
            "AUDIO_RENDER_PLAN_INVALID",
            "hash-pinned A2 cannot fall back to a legacy music-cues artifact.",
          );
        }
      } else {
        musicCuesPath = candidate;
      }
    }
  }

  let sfxCuesPath: string | undefined;
  if (!options.sfxCuesPath) {
    if (pinned.a3) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "hash-pinned A3 requires sfx-cues/v1; refusing direct timeline audio assembly.",
      );
    }
  } else {
    const candidate = path.resolve(options.sfxCuesPath);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      if (pinned.a3) {
        throw new AudioRenderPlanError(
          "AUDIO_RENDER_PLAN_INVALID",
          "hash-pinned A3 requires an existing sfx-cues/v1 artifact.",
        );
      }
    } else {
      const header = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (header.version !== "sfx-cues/v1") {
        if (pinned.a3) {
          throw new AudioRenderPlanError(
            "AUDIO_RENDER_PLAN_INVALID",
            "hash-pinned A3 cannot fall back to an unknown SFX artifact.",
          );
        }
      } else {
        sfxCuesPath = candidate;
      }
    }
  }
  if (!musicCuesPath && !sfxCuesPath && !pinned.musicMaster) {
    const hasProfileRequest = Boolean(
      options.audioDeliveryProfile
      || options.audioProfilePath
      || options.audioProfileId
      || pinned.audioProfileRef,
    );
    if (!hasProfileRequest && !pinned.a3Ambient && !pinned.a3Unsupported) return undefined;
  }
  const plan = (options.resolvePlanImpl ?? resolveAudioRenderPlan)({
    projectDir: options.projectDir,
    ...(options.repoSfxRoot ? { repoSfxRoot: options.repoSfxRoot } : {}),
    timelinePath: options.timelinePath,
    musicCuesPath,
    sfxCuesPath,
    sourceOverrides: options.sourceOverrides,
    packRegistryOptions: options.packRegistryOptions,
    resolveTrackImpl: options.resolveTrackImpl,
    masteringDefaults: options.masteringDefaults,
    audioDeliveryProfile: options.audioDeliveryProfile,
    audioProfilePath: options.audioProfilePath,
    audioProfileId: options.audioProfileId,
    audioProfilePlatform: options.audioProfilePlatform,
    audioProfileSurface: options.audioProfileSurface,
    audioProfileReleaseScope: options.audioProfileReleaseScope,
    audioProfileVariant: options.audioProfileVariant,
    audioProfileRootDir: options.audioProfileRootDir,
    now: options.now,
  });
  return plan.strategy === "explicit_music_cues_v2"
      || plan.strategy === "explicit_sfx_cues_v1"
      || plan.strategy === "explicit_music_and_sfx_cues_v1"
      || plan.strategy === "music_master"
      || (Boolean(options.audioDeliveryProfile || options.audioProfilePath || options.audioProfileId || pinned.audioProfileRef || pinned.a3Ambient || pinned.a3Unsupported)
        && (plan.strategy === "dialogue_only" || plan.strategy === "original_passthrough"))
    ? plan
    : undefined;
}
