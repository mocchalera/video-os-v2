/**
 * Music cue resolution — takes music_cues.json data and produces
 * A2 track clips for the timeline.
 *
 * Per milestone-4-design §Music Cues:
 * - Validates cue constraints (entry window, exit > entry, ducking params)
 * - Builds A2 track clips from cues
 * - Projects music cues into the timeline (immutable)
 */

// ── Types ──────────────────────────────────────────────────────────

export interface MusicAsset {
  asset_id: string;
  path: string;
  source_hash: string;
  analysis_ref?: string;
}

export interface EntryWindow {
  earliest_frame: number;
  latest_frame: number;
  basis?: string;
}

export interface DuckingParams {
  base_gain_db: number;
  duck_gain_db: number;
  attack_ms: number;
  release_ms: number;
}

export interface BeatSync {
  enabled?: boolean;
  analysis_ref?: string;
  align?: "entry" | "exit" | "both";
  bpm?: number;
  meter?: string;
  beats_sec?: number[];
  downbeats_sec?: number[];
  grid_source?: string;
}

export interface MusicCue {
  cue_id: string;
  track_id: string;
  entry_window: EntryWindow;
  entry_frame: number;
  exit_frame: number;
  fade_in_ms: number;
  fade_out_ms: number;
  ducking: DuckingParams;
  beat_sync?: BeatSync;
}

export interface MusicCuesDoc {
  version: string;
  project_id: string;
  base_timeline_version: string;
  /** Explicit operator intent. Missing social talking-head work defaults dialogue-first. */
  mix_profile?: "dialogue_first" | "balanced" | "music_forward";
  music_asset: MusicAsset;
  cues: MusicCue[];
}

export interface AppliedMusicMixProfile {
  doc: MusicCuesDoc;
  profile: "dialogue_first" | "balanced" | "music_forward";
  adjusted: boolean;
}

/**
 * Apply a conservative speech-first ceiling only to social talking-head work.
 * Explicit balanced/music-forward intent remains authoritative, and quieter
 * operator-authored values are never raised.
 */
export function applyMusicMixProfile(
  doc: MusicCuesDoc,
  genre: string | undefined,
): AppliedMusicMixProfile {
  const profile = doc.mix_profile
    ?? (genre === "social_talking_head" ? "dialogue_first" : "balanced");
  if (profile !== "dialogue_first") {
    return { doc, profile, adjusted: false };
  }

  let adjusted = false;
  const cues = doc.cues.map((cue) => {
    const ducking: DuckingParams = {
      ...cue.ducking,
      base_gain_db: Math.min(cue.ducking.base_gain_db, -10),
      duck_gain_db: Math.min(cue.ducking.duck_gain_db, -18),
      attack_ms: Math.max(cue.ducking.attack_ms, 20),
      release_ms: Math.max(cue.ducking.release_ms, 280),
    };
    adjusted ||= (
      ducking.base_gain_db !== cue.ducking.base_gain_db
      || ducking.duck_gain_db !== cue.ducking.duck_gain_db
      || ducking.attack_ms !== cue.ducking.attack_ms
      || ducking.release_ms !== cue.ducking.release_ms
    );
    return { ...cue, ducking };
  });

  return {
    doc: { ...doc, mix_profile: profile, cues },
    profile,
    adjusted,
  };
}

export interface BeatGridAnalysis {
  bpm?: number;
  meter?: string;
  beats_sec?: number[];
  downbeats_sec?: number[];
  provenance?: { detector?: string };
}

export function enrichMusicCuesWithBeatGrid(
  doc: MusicCuesDoc,
  analysis: BeatGridAnalysis,
): MusicCuesDoc {
  const beatsSec = sanitizeSeconds(analysis.beats_sec);
  const downbeatsSec = sanitizeSeconds(analysis.downbeats_sec);
  if (beatsSec.length === 0 && downbeatsSec.length === 0) return doc;

  return {
    ...doc,
    cues: doc.cues.map((cue) => ({
      ...cue,
      beat_sync: {
        ...(cue.beat_sync ?? {}),
        enabled: cue.beat_sync?.enabled ?? true,
        align: cue.beat_sync?.align ?? "both",
        ...(typeof analysis.bpm === "number" && Number.isFinite(analysis.bpm) ? { bpm: analysis.bpm } : {}),
        ...(analysis.meter ? { meter: analysis.meter } : {}),
        ...(beatsSec.length > 0 ? { beats_sec: beatsSec } : {}),
        ...(downbeatsSec.length > 0 ? { downbeats_sec: downbeatsSec } : {}),
        grid_source: analysis.provenance?.detector ?? "bgm_analysis",
      },
    })),
  };
}

function sanitizeSeconds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value * 1000) / 1000)
    .sort((a, b) => a - b);
  return sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]);
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate music cues: entry_frame in entry_window, exit > entry,
 * valid ducking params.
 */
export function validateMusicCues(doc: MusicCuesDoc): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!doc.music_asset || !doc.music_asset.asset_id) {
    errors.push("music_asset.asset_id is required");
  }

  if (!Array.isArray(doc.cues) || doc.cues.length === 0) {
    errors.push("At least one cue is required");
  }

  for (const cue of doc.cues) {
    const prefix = `cue[${cue.cue_id}]`;

    // entry_frame must be within entry_window
    if (cue.entry_frame < cue.entry_window.earliest_frame) {
      errors.push(`${prefix}: entry_frame (${cue.entry_frame}) < earliest_frame (${cue.entry_window.earliest_frame})`);
    }
    if (cue.entry_frame > cue.entry_window.latest_frame) {
      errors.push(`${prefix}: entry_frame (${cue.entry_frame}) > latest_frame (${cue.entry_window.latest_frame})`);
    }

    // exit must be after entry
    if (cue.exit_frame <= cue.entry_frame) {
      errors.push(`${prefix}: exit_frame (${cue.exit_frame}) must be > entry_frame (${cue.entry_frame})`);
    }

    // Fade durations must be non-negative
    if (cue.fade_in_ms < 0) {
      errors.push(`${prefix}: fade_in_ms must be >= 0`);
    }
    if (cue.fade_out_ms < 0) {
      errors.push(`${prefix}: fade_out_ms must be >= 0`);
    }

    // Ducking params validation
    if (cue.ducking.duck_gain_db > cue.ducking.base_gain_db) {
      errors.push(`${prefix}: duck_gain_db (${cue.ducking.duck_gain_db}) should be <= base_gain_db (${cue.ducking.base_gain_db})`);
    }
    if (cue.ducking.attack_ms < 0) {
      errors.push(`${prefix}: ducking.attack_ms must be >= 0`);
    }
    if (cue.ducking.release_ms < 0) {
      errors.push(`${prefix}: ducking.release_ms must be >= 0`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── A2 Track Clip Builder ──────────────────────────────────────────

/**
 * Build A2 track clips from music cues for timeline projection.
 *
 * Each cue becomes a clip:
 * - track_id: "A2", kind: "audio", role: "music"
 * - asset_id = music_asset.asset_id
 * - segment_id = cue_id
 * - timeline_in_frame = entry_frame
 * - timeline_duration_frames = exit_frame - entry_frame
 * - metadata.music_cue captures the cue parameters
 */
export function buildA2TrackClips(doc: MusicCuesDoc): Array<{
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: string;
  motivation: string;
  beat_id: string;
  fallback_segment_ids: string[];
  confidence: number;
  quality_flags: string[];
  metadata: { music_cue: Omit<MusicCue, "cue_id" | "track_id"> & { cue_id: string } };
}> {
  return doc.cues.map((cue) => {
    const durationFrames = cue.exit_frame - cue.entry_frame;

    return {
      clip_id: `A2_${cue.cue_id}`,
      segment_id: cue.cue_id,
      asset_id: doc.music_asset.asset_id,
      src_in_us: 0,
      src_out_us: 0,
      timeline_in_frame: cue.entry_frame,
      timeline_duration_frames: durationFrames,
      role: "music",
      motivation: "background_music",
      beat_id: "",
      fallback_segment_ids: [],
      confidence: 1.0,
      quality_flags: [],
      metadata: {
        music_cue: {
          cue_id: cue.cue_id,
          entry_window: cue.entry_window,
          entry_frame: cue.entry_frame,
          exit_frame: cue.exit_frame,
          fade_in_ms: cue.fade_in_ms,
          fade_out_ms: cue.fade_out_ms,
          ducking: cue.ducking,
          ...(cue.beat_sync ? { beat_sync: cue.beat_sync } : {}),
        },
      },
    };
  });
}

// ── Timeline Projection ────────────────────────────────────────────

/**
 * Project music cues into timeline: add A2 track to tracks.audio.
 * Returns a new timeline object (no mutation of the original).
 */
export function projectMusicToTimeline(timeline: any, doc: MusicCuesDoc, fps: number): any {
  const clips = buildA2TrackClips(doc);

  // Compute src_in_us / src_out_us using fps for frame-to-us conversion
  const usPerFrame = 1_000_000 / fps;
  const enrichedClips = clips.map((clip) => ({
    ...clip,
    src_in_us: Math.round(clip.timeline_in_frame * usPerFrame),
    src_out_us: Math.round(
      (clip.timeline_in_frame + clip.timeline_duration_frames) * usPerFrame,
    ),
  }));

  // Deep-clone timeline to avoid mutation
  const result = JSON.parse(JSON.stringify(timeline));

  // Ensure tracks.audio exists
  if (!result.tracks) {
    result.tracks = {};
  }
  if (!result.tracks.audio) {
    result.tracks.audio = [];
  }

  // Build the A2 track entry
  const a2Track = {
    track_id: "A2",
    kind: "audio",
    role: "music",
    clips: enrichedClips,
  };

  // Replace existing A2 track or append
  const existingIdx = result.tracks.audio.findIndex(
    (t: any) => t.track_id === "A2",
  );
  if (existingIdx >= 0) {
    result.tracks.audio[existingIdx] = a2Track;
  } else {
    result.tracks.audio.push(a2Track);
  }

  return result;
}
