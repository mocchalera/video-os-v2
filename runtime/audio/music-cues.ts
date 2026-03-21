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
  music_asset: MusicAsset;
  cues: MusicCue[];
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
