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
  /** music-cues/v2 Pack identity. Additive so legacy project-local assets remain readable. */
  track_id?: string;
  pack_id?: string;
  pack_version?: string;
  pack_manifest_hash?: string;
  full_mix_content_hash?: string;
  full_mix_size_bytes?: number;
  analysis_content_hash?: string;
  analysis_size_bytes?: number;
  analysis_status?: "ready" | "degraded" | "failed" | "unavailable";
  duration_us?: number;
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

export interface BeatAlignmentDecision {
  requested: "semantic_anchor_source_onset";
  status: "aligned" | "degraded";
  decision: "explicit_source_onset";
  analysis_status: "ready" | "degraded" | "failed" | "unavailable";
  confidence: number | null;
  grid_source: "canonical_analysis" | null;
  source_onset_us: number;
  timeline_boundaries_moved: false;
  warnings: string[];
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
  /** music-cues/v2 additive placement truth. */
  timeline_track_id?: "A2";
  source_offset_us?: number;
  source_range?: { in_us: number; out_us: number };
  timeline_range?: { in_frame: number; out_frame: number };
  section?: string;
  phase?: string;
  semantic_anchor?: {
    label: string;
    timeline_frame: number;
    source_onset_us: number;
  };
  beat_alignment?: BeatAlignmentDecision;
}

export interface MusicCueV2 extends MusicCue {
  timeline_track_id: "A2";
  source_offset_us: number;
  source_range: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  section: string;
  phase: string;
  semantic_anchor: {
    label: string;
    timeline_frame: number;
    source_onset_us: number;
  };
  beat_alignment: BeatAlignmentDecision;
}

export interface MusicCuesDoc {
  version: string;
  project_id: string;
  base_timeline_version: string;
  /** Explicit operator intent. Missing social talking-head work defaults dialogue-first. */
  mix_profile?: "dialogue_first" | "balanced" | "music_forward";
  music_asset: MusicAsset;
  cues: MusicCue[];
  /** music-cues/v2 additive authority and rational timing contract. */
  selection_ref?: { path: string; content_hash: string };
  timeline_fps?: { num: number; den: number };
  planning_status?: "verified" | "verified_with_warnings";
  warnings?: string[];
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

  const cueIds = new Set<string>();
  const ranges: Array<{ cueId: string; start: number; end: number }> = [];
  for (const cue of doc.cues) {
    const prefix = `cue[${cue.cue_id}]`;
    if (cueIds.has(cue.cue_id)) {
      errors.push(`${prefix}: cue_id must be unique`);
    }
    cueIds.add(cue.cue_id);

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

    if (doc.version === "2.0.0") {
      if (cue.track_id !== doc.music_asset.track_id) {
        errors.push(`${prefix}: track_id must match music_asset.track_id`);
      }
      if (cue.timeline_track_id !== "A2") {
        errors.push(`${prefix}: timeline_track_id must be A2`);
      }
      if (!cue.source_range || cue.source_range.out_us <= cue.source_range.in_us) {
        errors.push(`${prefix}: source_range must have positive duration`);
      }
      if (cue.source_offset_us !== cue.source_range?.in_us) {
        errors.push(`${prefix}: source_offset_us must equal source_range.in_us`);
      }
      if (
        !cue.timeline_range
        || cue.timeline_range.in_frame !== cue.entry_frame
        || cue.timeline_range.out_frame !== cue.exit_frame
      ) {
        errors.push(`${prefix}: timeline_range must match entry_frame/exit_frame`);
      }
      if (
        cue.semantic_anchor
        && (cue.semantic_anchor.timeline_frame < cue.entry_frame
          || cue.semantic_anchor.timeline_frame >= cue.exit_frame)
      ) {
        errors.push(`${prefix}: semantic_anchor.timeline_frame must be inside the cue`);
      }
      if (
        cue.semantic_anchor
        && cue.source_range
        && (cue.semantic_anchor.source_onset_us < cue.source_range.in_us
          || cue.semantic_anchor.source_onset_us >= cue.source_range.out_us)
      ) {
        errors.push(`${prefix}: semantic_anchor.source_onset_us must be inside the source range`);
      }
      if (cue.beat_alignment?.timeline_boundaries_moved !== false) {
        errors.push(`${prefix}: Phase 2 beat alignment may not move timeline boundaries`);
      }
      if (cue.source_range && doc.timeline_fps) {
        const expectedSourceDurationUs = Math.round(
          (cue.exit_frame - cue.entry_frame)
          * 1_000_000
          * doc.timeline_fps.den
          / doc.timeline_fps.num,
        );
        if (cue.source_range.out_us - cue.source_range.in_us !== expectedSourceDurationUs) {
          errors.push(`${prefix}: source duration must equal rational-fps timeline duration`);
        }
      }
      ranges.push({ cueId: cue.cue_id, start: cue.entry_frame, end: cue.exit_frame });
    }
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end || left.cueId.localeCompare(right.cueId));
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      errors.push(`cue[${ranges[index].cueId}]: A2 cue range overlaps cue[${ranges[index - 1].cueId}]`);
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
  metadata: {
    music_cue: Omit<MusicCue, "cue_id" | "track_id"> & { cue_id: string; selected_track_id: string };
    music_asset: {
      track_id: string;
      pack_id?: string;
      pack_version?: string;
      pack_manifest_hash?: string;
      full_mix_content_hash: string;
      analysis_content_hash?: string;
      analysis_status?: string;
      path: string;
      selection_ref?: MusicCuesDoc["selection_ref"];
    };
  };
}> {
  return doc.cues.map((cue) => {
    const durationFrames = cue.exit_frame - cue.entry_frame;
    const v2Source = doc.version === "2.0.0" ? cue.source_range : undefined;
    const alignmentConfidence = cue.beat_alignment?.confidence;
    const confidence = typeof alignmentConfidence === "number"
      ? Math.min(1, Math.max(0, alignmentConfidence))
      : doc.version === "2.0.0"
        ? 0
        : 1;
    const qualityFlags = [
      ...(doc.music_asset.analysis_status && doc.music_asset.analysis_status !== "ready"
        ? [`bgm_analysis_${doc.music_asset.analysis_status}`]
        : []),
      ...(cue.beat_alignment?.status === "degraded" ? ["beat_alignment_degraded"] : []),
    ];

    return {
      clip_id: `A2_${cue.cue_id}`,
      segment_id: cue.cue_id,
      asset_id: doc.music_asset.asset_id,
      src_in_us: v2Source?.in_us ?? 0,
      src_out_us: v2Source?.out_us ?? 0,
      timeline_in_frame: cue.entry_frame,
      timeline_duration_frames: durationFrames,
      role: "music",
      motivation: "background_music",
      beat_id: "",
      fallback_segment_ids: [],
      confidence,
      quality_flags: qualityFlags,
      metadata: {
        music_cue: {
          cue_id: cue.cue_id,
          selected_track_id: cue.track_id,
          entry_window: cue.entry_window,
          entry_frame: cue.entry_frame,
          exit_frame: cue.exit_frame,
          fade_in_ms: cue.fade_in_ms,
          fade_out_ms: cue.fade_out_ms,
          ducking: cue.ducking,
          ...(cue.timeline_track_id ? { timeline_track_id: cue.timeline_track_id } : {}),
          ...(cue.source_offset_us !== undefined ? { source_offset_us: cue.source_offset_us } : {}),
          ...(cue.source_range ? { source_range: cue.source_range } : {}),
          ...(cue.timeline_range ? { timeline_range: cue.timeline_range } : {}),
          ...(cue.section ? { section: cue.section } : {}),
          ...(cue.phase ? { phase: cue.phase } : {}),
          ...(cue.semantic_anchor ? { semantic_anchor: cue.semantic_anchor } : {}),
          ...(cue.beat_alignment ? { beat_alignment: cue.beat_alignment } : {}),
          ...(cue.beat_sync ? { beat_sync: cue.beat_sync } : {}),
        },
        music_asset: {
          track_id: doc.music_asset.track_id ?? doc.music_asset.asset_id,
          ...(doc.music_asset.pack_id ? { pack_id: doc.music_asset.pack_id } : {}),
          ...(doc.music_asset.pack_version ? { pack_version: doc.music_asset.pack_version } : {}),
          ...(doc.music_asset.pack_manifest_hash ? { pack_manifest_hash: doc.music_asset.pack_manifest_hash } : {}),
          full_mix_content_hash: doc.music_asset.full_mix_content_hash ?? doc.music_asset.source_hash,
          ...(doc.music_asset.analysis_content_hash
            ? { analysis_content_hash: doc.music_asset.analysis_content_hash }
            : {}),
          ...(doc.music_asset.analysis_status ? { analysis_status: doc.music_asset.analysis_status } : {}),
          path: doc.music_asset.path,
          ...(doc.selection_ref ? { selection_ref: doc.selection_ref } : {}),
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
export interface RationalFps {
  fpsNum: number;
  fpsDen: number;
}

function rationalFps(value: number | RationalFps): RationalFps {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("Music cue projection requires a positive fps value.");
    }
    // Preserve the legacy numeric API, including decimal rates. New v2 callers
    // use the exact {fpsNum,fpsDen} form below.
    return { fpsNum: value, fpsDen: 1 };
  }
  const fps = value;
  if (
    !Number.isSafeInteger(fps.fpsNum)
    || !Number.isSafeInteger(fps.fpsDen)
    || fps.fpsNum <= 0
    || fps.fpsDen <= 0
  ) {
    throw new Error("Music cue projection requires a positive rational fps contract.");
  }
  return fps;
}

function timelineTailFrame(timeline: any): number {
  const groups = [
    ...(Array.isArray(timeline?.tracks?.video) ? timeline.tracks.video : []),
    ...(Array.isArray(timeline?.tracks?.audio) ? timeline.tracks.audio : []),
  ];
  return groups.flatMap((track: any) => Array.isArray(track?.clips) ? track.clips : [])
    .reduce((tail: number, clip: any) => {
      const start = Number.isSafeInteger(clip?.timeline_in_frame) ? clip.timeline_in_frame : 0;
      const duration = Number.isSafeInteger(clip?.timeline_duration_frames) ? clip.timeline_duration_frames : 0;
      return Math.max(tail, start + duration);
    }, 0);
}

function cueIdFromClip(clip: any): string | undefined {
  const cue = clip?.metadata?.music_cue;
  return cue && typeof cue === "object" && typeof cue.cue_id === "string"
    ? cue.cue_id
    : undefined;
}

export function projectMusicToTimeline(
  timeline: any,
  doc: MusicCuesDoc,
  fps: number | RationalFps,
): any {
  const validation = validateMusicCues(doc);
  if (!validation.valid) {
    throw new Error(`Invalid music_cues: ${validation.errors.join("; ")}`);
  }
  const { fpsNum, fpsDen } = rationalFps(fps);
  if (
    doc.version === "2.0.0"
    && doc.timeline_fps
    && (doc.timeline_fps.num !== fpsNum || doc.timeline_fps.den !== fpsDen)
  ) {
    throw new Error("music_cues rational fps pin does not match the target timeline.");
  }
  const clips = buildA2TrackClips(doc);

  // Legacy cues inferred source time from frame placement. v2 owns source
  // ranges explicitly and must never re-infer them from timeline position.
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const enrichedClips = clips.map((clip) => ({
    ...clip,
    src_in_us: doc.version === "2.0.0"
      ? clip.src_in_us
      : Math.round(clip.timeline_in_frame * usPerFrame),
    src_out_us: doc.version === "2.0.0"
      ? clip.src_out_us
      : Math.round((clip.timeline_in_frame + clip.timeline_duration_frames) * usPerFrame),
  }));

  // Deep-clone timeline to avoid mutation
  const result = JSON.parse(JSON.stringify(timeline));
  if (doc.version === "2.0.0") {
    const tail = timelineTailFrame(result);
    for (const clip of enrichedClips) {
      if (clip.timeline_in_frame + clip.timeline_duration_frames > tail) {
        throw new Error(`Music cue ${clip.segment_id} exceeds the target timeline tail.`);
      }
      if (
        typeof doc.music_asset.duration_us === "number"
        && clip.src_out_us > doc.music_asset.duration_us
      ) {
        throw new Error(`Music cue ${clip.segment_id} exceeds the verified source duration.`);
      }
    }
  }

  // Ensure tracks.audio exists
  if (!result.tracks) {
    result.tracks = {};
  }
  if (!result.tracks.audio) {
    result.tracks.audio = [];
  }

  // Merge by cue identity. A second projection replaces the same cue rather
  // than appending it, while unrelated existing A2 material is preserved.
  const existingIdx = result.tracks.audio.findIndex(
    (t: any) => t.track_id === "A2",
  );
  const existingA2 = existingIdx >= 0 ? result.tracks.audio[existingIdx] : undefined;
  const plannedCueIds = new Set(doc.cues.map((cue) => cue.cue_id));
  const retained = (Array.isArray(existingA2?.clips) ? existingA2.clips : [])
    .filter((clip: any) => !plannedCueIds.has(cueIdFromClip(clip) ?? "")
      && !enrichedClips.some((planned) => planned.clip_id === clip.clip_id));
  const mergedClips = [...retained, ...enrichedClips].sort((left: any, right: any) =>
    left.timeline_in_frame - right.timeline_in_frame
    || left.clip_id.localeCompare(right.clip_id));
  const a2Track = {
    ...(existingA2 ?? {}),
    track_id: "A2",
    kind: "audio",
    role: "music",
    clips: mergedClips,
  };
  if (existingIdx >= 0) {
    result.tracks.audio[existingIdx] = a2Track;
  } else {
    result.tracks.audio.push(a2Track);
  }

  return result;
}
