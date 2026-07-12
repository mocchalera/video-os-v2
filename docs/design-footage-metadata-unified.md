# Design Addendum: Unified Footage Metadata

Date: 2026-06-19
Status: Addendum to `docs/design-footage-database-unified.md`
Scope: design only. This document proposes additive metadata tables and search API extensions for the derived `footage.db`.

Related:

- `docs/design-footage-database-unified.md`
- `docs/design-footage-metadata-cinematography.md`
- `docs/design-footage-metadata-editorial-grammar.md`
- `docs/design-footage-metadata-production-standards.md`
- `runtime/connectors/marlin-types.ts`
- `runtime/connectors/ffprobe.ts`
- `runtime/tools/footage-search.ts`
- `runtime/artifacts/footage-db-builder.ts`

## 1. Decision

Add a small metadata layer to the existing derived SQLite database at:

```text
projects/<project-id>/03_analysis/search/footage.db
```

The metadata layer should stay rebuildable, project-local, and read-only from the agent point of view. It must not widen `segments.json`, `assets.json`, `selects_candidates.yaml`, `edit_blueprint.yaml`, or `timeline.json`.

The unified layer keeps only metadata that changes actual edit decisions:

1. Asset technical facts: codec, resolution, frame rate, color tags, rotation, audio stream layout.
2. Segment visual/editing profile: camera motion, stability, shot scale, subject position, subject/action direction, color/exposure traits.
3. Segment audio profile: dialogue/music/ambient flags, peak/RMS/LUFS, silence windows, noise flags.
4. Segment logging profile: scene/shot/take, circle take, camera/card, custom tags, operator notes.
5. Pair compatibility, later only: targeted fine-cut repair rows for axis continuity, shot-reverse, match cut, dissolve, hard cut, and breathing room.

Do not implement a full NLE metadata database. No lens catalog, full MXF package graph, exact pose/gaze model, full conform ledger, or O(n squared) pair universe is needed for the next rough-cut pipeline run.

## 2. Prioritized Metadata

Priority uses three criteria:

- Editing impact: does it improve cuts, substitutions, pacing, continuity, or handoff?
- Extractability: can the current repo derive it without new model/hardware risk?
- Effort: can it be added to the existing `footage.db` builder/search path without broad runtime changes?

| Priority | Build | Metadata | Impact | Extractability | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | Sprint 1 | Codec, resolution, frame rate, rotation, audio stream layout | Medium | High via ffprobe | Low | Build now. Enables compatibility and export warnings. |
| P0 | Sprint 1 | Camera motion description/type when explicit in Marlin | High | Medium | Low | Build now as conservative hints, not geometry facts. |
| P0 | Sprint 1 | Shot stability | High | Medium | Low | Build now from quality flags, Marlin phrases, and later frame variance. |
| P0 | Sprint 1 | Basic shot scale | High | Medium | Medium | Build now with conservative labels; improve in Sprint 2. |
| P0 | Sprint 1 | Audio levels and silence | High | High with ffmpeg filters | Medium | Build now. ffprobe alone cannot compute levels. |
| P0 | Sprint 1 | Dialogue/music/ambient/silence role | High | Medium | Medium | Build now from transcript, segment type, VAD/silence, and weak heuristics. |
| P0 | Sprint 1 | Scene/shot/take/circle/custom tags from user annotation | High | High when provided | Low | Build now as explicit annotation import, never inferred freely. |
| P1 | Sprint 2 | Subject screen side and composition anchor | High | Medium with frame analysis | Medium | Build soon from sampled frame boxes/heuristics. |
| P1 | Sprint 2 | Dominant colors, exposure, contrast, saturation | Medium | High with frame stats | Medium | Build soon for visual continuity and palette searches. |
| P1 | Sprint 2 | Motion energy and subject movement direction | High | Medium with optical flow/tracking | Medium-high | Build soon, with camera-motion separation warnings. |
| P2 | Sprint 3 | Pair compatibility rows | High for fine cut | Medium | Medium-high | Build only for targeted candidate pairs, not all pairs. |
| P3 | Later | Face direction, eyeline, body pose | High in dialogue | Low without new models | High | Defer until local pose/face model is approved. |
| P3 | Later | Precise depth of field | Medium | Low | High | Defer. Store only coarse/unknown until a reliable extractor exists. |
| Reject for now | Later | Lens focal length, iris, focus distance, full conform graph | Low for rough cut | Low/variable | High | Keep out of rough-cut metadata unless source tags provide it and a handoff feature needs it. |

## 3. Unified Taxonomy

Use one vocabulary per concept. The three source drafts overlap on camera movement, shot scale, direction, energy, color, and production logging; this addendum resolves those overlaps as follows.

### 3.1 Camera Motion

Use the compiler/search-friendly motion vocabulary:

```ts
export type CameraMotionType =
  | "static"
  | "pan"
  | "tilt"
  | "push_in"
  | "pull_out"
  | "tracking"
  | "handheld"
  | "reveal"
  | "fast_action"
  | "mixed"
  | "unknown";
```

Rejected vocabulary:

- Do not store `dolly` separately in the search API for now. Normalize clear dolly-in to `push_in` and dolly-out to `pull_out`.
- Do not store `steadicam`, `crane`, or `drone_orbit` as top-level filters in Sprint 1. Put those words in `camera_motion_description` and metadata FTS. Promote only after repeated agent use.

Direction vocabulary:

```ts
export type ScreenMotionDirection =
  | "none"
  | "ltr"
  | "rtl"
  | "up"
  | "down"
  | "toward_camera"
  | "away_camera"
  | "mixed"
  | "unknown";
```

Use screen-readable direction, not world direction. Marlin prose can set this only when it explicitly says a direction.

### 3.2 Shot Scale

Use the existing transition-compatible scale order plus `detail`:

```ts
export type UnifiedShotScale =
  | "extreme_wide"
  | "wide"
  | "medium_wide"
  | "medium"
  | "medium_close"
  | "close"
  | "extreme_close"
  | "detail"
  | "unknown";
```

Mapping rules:

| Incoming term | Unified value |
| --- | --- |
| `full` | `medium_wide` |
| `medium_close_up` | `medium_close` |
| `close_up` | `close` |
| `extreme_close_up` | `extreme_close` |
| insert/detail/object texture | `detail` |

This avoids maintaining one taxonomy for cinematography and another for compiler adjacency.

### 3.3 Subject And Action Direction

Sprint 1 stores only coarse action direction from explicit event text. Sprint 2 adds frame-derived subject position.

```ts
export type SubjectScreenSide = "left" | "center" | "right" | "mixed" | "none" | "unknown";
export type SubjectMovementDirection =
  | "ltr"
  | "rtl"
  | "toward_camera"
  | "away_camera"
  | "static"
  | "mixed"
  | "unknown";
```

Do not infer face direction, eyeline, or body pose in Sprint 1 or 2. Those are `Later` fields because noisy geometry will hurt continuity decisions more than missing geometry.

### 3.4 Color And Exposure

Keep technical color facts separate from editorial color traits.

- Technical facts live on `asset_technical_metadata`: `color_primaries`, `color_transfer`, `color_space`, `color_range`, `pix_fmt`, `bit_depth`.
- Editorial traits live on `segment_visual_profile`: `exposure_label`, `color_temperature`, `contrast_label`, `saturation_label`, `dominant_colors_json`.

### 3.5 Pair Compatibility

Pair rows are fine-cut metadata, not rough-cut prerequisites.

Accepted pair types:

```ts
export type SegmentPairType =
  | "axis_continuity"
  | "shot_reverse"
  | "match_cut"
  | "dissolve"
  | "hard_cut"
  | "breathing_room";
```

Deferred pair types:

- `j_cut` and `l_cut` are useful search signals later, but they should not imply the compiler can execute audio overlap until the audio IR supports it cleanly.
- `dip_to_black` can be represented by `hard_cut` or `breathing_room` metadata until a concrete chapter-boundary workflow needs it.

## 4. SQLite DDL Additions

The current DB builder creates `schema_version = "1"`. This addendum should be implemented as a rebuild to `schema_version = "2"` or as `metadata_schema_version = "1"` in `footage_db_meta` while leaving the base schema version unchanged during rollout.

No in-place migration is required. `footage.db` is a derived artifact; rebuild it atomically.

### 4.1 Asset Technical Metadata

```sql
CREATE TABLE asset_technical_metadata (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,

  container_format TEXT,
  container_long_name TEXT,
  recording_format TEXT,

  video_codec TEXT,
  video_profile TEXT,
  codec_tag TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  fps_num INTEGER CHECK (fps_num IS NULL OR fps_num > 0),
  fps_den INTEGER CHECK (fps_den IS NULL OR fps_den > 0),
  r_frame_rate TEXT,
  time_base TEXT,
  frame_rate_mode TEXT CHECK (
    frame_rate_mode IS NULL OR frame_rate_mode IN ('cfr', 'vfr', 'audio_only', 'unknown')
  ),
  pix_fmt TEXT,
  bit_depth INTEGER CHECK (bit_depth IS NULL OR bit_depth > 0),

  color_primaries TEXT,
  color_transfer TEXT,
  color_space TEXT,
  color_range TEXT,
  rotation INTEGER CHECK (rotation IS NULL OR rotation IN (0, 90, 180, 270)),

  stream_duration_json TEXT NOT NULL DEFAULT '[]',
  audio_streams_json TEXT NOT NULL DEFAULT '[]',

  timecode_start TEXT,
  timecode_format TEXT CHECK (
    timecode_format IS NULL OR timecode_format IN ('none', 'non_drop', 'drop_frame', 'inferred', 'unknown')
  ),
  reel_name TEXT,
  card_id TEXT,
  camera_id TEXT,

  extraction_source_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_asset_technical_codec
  ON asset_technical_metadata(video_codec, video_profile, recording_format);

CREATE INDEX idx_asset_technical_resolution
  ON asset_technical_metadata(width, height);

CREATE INDEX idx_asset_technical_rate
  ON asset_technical_metadata(fps_num, fps_den, frame_rate_mode);

CREATE INDEX idx_asset_technical_color
  ON asset_technical_metadata(color_primaries, color_transfer, color_space);

CREATE INDEX idx_asset_technical_reel
  ON asset_technical_metadata(reel_name, card_id, camera_id);
```

### 4.2 Segment Visual Profile

This table merges the practical parts of cinematography, editorial grammar, and color design. It is segment-level because the current `search_footage` API returns segments.

```sql
CREATE TABLE segment_visual_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  camera_motion_description TEXT NOT NULL DEFAULT '',
  camera_motion_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_motion_type IN (
      'static', 'pan', 'tilt', 'push_in', 'pull_out', 'tracking',
      'handheld', 'reveal', 'fast_action', 'mixed', 'unknown'
    )
  ),
  camera_motion_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_motion_direction IN (
      'none', 'ltr', 'rtl', 'up', 'down', 'toward_camera', 'away_camera', 'mixed', 'unknown'
    )
  ),
  camera_stability TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_stability IN ('stable', 'slight', 'shaky', 'unknown')
  ),
  motion_energy REAL CHECK (motion_energy IS NULL OR (motion_energy >= 0 AND motion_energy <= 1)),
  camera_motion_energy REAL CHECK (
    camera_motion_energy IS NULL OR (camera_motion_energy >= 0 AND camera_motion_energy <= 1)
  ),

  shot_scale TEXT NOT NULL DEFAULT 'unknown' CHECK (
    shot_scale IN (
      'extreme_wide', 'wide', 'medium_wide', 'medium',
      'medium_close', 'close', 'extreme_close', 'detail', 'unknown'
    )
  ),
  composition_anchor TEXT NOT NULL DEFAULT 'unknown' CHECK (
    composition_anchor IN ('left', 'center_left', 'center', 'center_right', 'right', 'unknown')
  ),
  subject_screen_side TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_screen_side IN ('left', 'center', 'right', 'mixed', 'none', 'unknown')
  ),
  dominant_subject_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
    dominant_subject_type IN ('person', 'group', 'object', 'vehicle', 'environment', 'none', 'unknown')
  ),
  subject_movement_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_movement_direction IN ('ltr', 'rtl', 'toward_camera', 'away_camera', 'static', 'mixed', 'unknown')
  ),

  exposure_label TEXT NOT NULL DEFAULT 'unknown' CHECK (
    exposure_label IN ('under', 'normal', 'over', 'mixed', 'unknown')
  ),
  color_temperature TEXT NOT NULL DEFAULT 'unknown' CHECK (
    color_temperature IN ('warm', 'neutral', 'cool', 'mixed', 'unknown')
  ),
  contrast_label TEXT NOT NULL DEFAULT 'unknown' CHECK (
    contrast_label IN ('low', 'normal', 'high', 'mixed', 'unknown')
  ),
  saturation_label TEXT NOT NULL DEFAULT 'unknown' CHECK (
    saturation_label IN ('muted', 'normal', 'vivid', 'mixed', 'unknown')
  ),
  dominant_colors_json TEXT NOT NULL DEFAULT '[]',
  sampled_frame_count INTEGER NOT NULL DEFAULT 0 CHECK (sampled_frame_count >= 0),

  depth_of_field TEXT NOT NULL DEFAULT 'unknown' CHECK (
    depth_of_field IN ('shallow', 'medium', 'deep', 'unknown')
  ),

  motion_confidence REAL CHECK (motion_confidence IS NULL OR (motion_confidence >= 0 AND motion_confidence <= 1)),
  scale_confidence REAL CHECK (scale_confidence IS NULL OR (scale_confidence >= 0 AND scale_confidence <= 1)),
  subject_confidence REAL CHECK (subject_confidence IS NULL OR (subject_confidence >= 0 AND subject_confidence <= 1)),
  color_confidence REAL CHECK (color_confidence IS NULL OR (color_confidence >= 0 AND color_confidence <= 1)),
  depth_confidence REAL CHECK (depth_confidence IS NULL OR (depth_confidence >= 0 AND depth_confidence <= 1)),

  extraction_source_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_visual_motion
  ON segment_visual_profile(camera_motion_type, camera_motion_direction, camera_stability);

CREATE INDEX idx_segment_visual_energy
  ON segment_visual_profile(motion_energy, camera_motion_energy);

CREATE INDEX idx_segment_visual_scale
  ON segment_visual_profile(shot_scale, scale_confidence);

CREATE INDEX idx_segment_visual_subject
  ON segment_visual_profile(subject_screen_side, dominant_subject_type, subject_movement_direction);

CREATE INDEX idx_segment_visual_color
  ON segment_visual_profile(exposure_label, color_temperature, contrast_label, saturation_label);
```

Implementation note: `depth_of_field` is included so later frame/model analysis has a stable slot, but Sprint 1 and 2 should usually write `unknown`. Search must not use depth as a hard gate until `depth_confidence` is high and the extractor is validated.

### 4.3 Segment Audio Profile

`ffprobe.ts` exposes stream layout. Numeric levels require `ffmpeg` filters such as `astats`, `ebur128`, and `silencedetect`; ffprobe alone does not produce peak/RMS/LUFS.

```sql
CREATE TABLE segment_audio_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  audio_role TEXT NOT NULL DEFAULT 'unknown' CHECK (
    audio_role IN ('dialogue', 'music', 'ambient', 'silence', 'mixed', 'unknown')
  ),
  has_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (has_dialogue IN (0, 1)),
  has_music INTEGER NOT NULL DEFAULT 0 CHECK (has_music IN (0, 1)),
  has_ambient INTEGER NOT NULL DEFAULT 0 CHECK (has_ambient IN (0, 1)),

  peak_dbfs REAL,
  rms_dbfs REAL,
  integrated_lufs REAL,
  silence_ratio REAL CHECK (silence_ratio IS NULL OR (silence_ratio >= 0 AND silence_ratio <= 1)),
  silence_head_us INTEGER CHECK (silence_head_us IS NULL OR silence_head_us >= 0),
  silence_tail_us INTEGER CHECK (silence_tail_us IS NULL OR silence_tail_us >= 0),
  speech_density REAL CHECK (speech_density IS NULL OR (speech_density >= 0 AND speech_density <= 1)),
  music_density REAL CHECK (music_density IS NULL OR (music_density >= 0 AND music_density <= 1)),

  noise_flags_json TEXT NOT NULL DEFAULT '[]',
  audio_handle_head_us INTEGER CHECK (audio_handle_head_us IS NULL OR audio_handle_head_us >= 0),
  audio_handle_tail_us INTEGER CHECK (audio_handle_tail_us IS NULL OR audio_handle_tail_us >= 0),

  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extraction_source_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_audio_role
  ON segment_audio_profile(audio_role, has_dialogue, has_music, has_ambient);

CREATE INDEX idx_segment_audio_levels
  ON segment_audio_profile(peak_dbfs, integrated_lufs);

CREATE INDEX idx_segment_audio_silence
  ON segment_audio_profile(silence_ratio, silence_head_us, silence_tail_us);
```

### 4.4 Segment Logging Profile

This is user/operator metadata materialized per segment. If the source annotation is asset-level, the builder can apply it to all child segments and keep the original scope in `evidence_json`.

```sql
CREATE TABLE segment_logging_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  scene_number TEXT,
  shot_number TEXT,
  take_number TEXT,
  camera_id TEXT,
  card_id TEXT,

  circle_take INTEGER CHECK (circle_take IS NULL OR circle_take IN (0, 1)),
  best_take INTEGER CHECK (best_take IS NULL OR best_take IN (0, 1)),
  custom_tags_json TEXT NOT NULL DEFAULT '[]',
  operator_notes TEXT NOT NULL DEFAULT '',

  source TEXT NOT NULL CHECK (
    source IN ('user_annotation', 'filename_parser', 'manifest', 'imported_log', 'unknown')
  ),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_logging_scene_take
  ON segment_logging_profile(scene_number, shot_number, take_number);

CREATE INDEX idx_segment_logging_camera
  ON segment_logging_profile(camera_id, card_id);

CREATE INDEX idx_segment_logging_circle
  ON segment_logging_profile(circle_take, best_take);
```

Filename parsing must be configured and confidence-scored. Without a configured pattern, leave fields null.

### 4.5 Metadata FTS

Do not alter the existing `segments_fts` table in place. Add a separate virtual table so old search keeps working when metadata is absent.

```sql
CREATE VIRTUAL TABLE segment_metadata_fts USING fts5(
  segment_id UNINDEXED,
  cinematography,
  technical,
  audio,
  logging,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-'"
);
```

Populate compact normalized terms, for example:

```text
camera pan ltr slight shot medium_close subject person center action static warm normal exposure dialogue lufs -18 circle_take scene 03 shot 02
```

Embedding policy:

- Keep `embedding_texts.field` as `summary`, `transcript`, `scene`, `combined`.
- Do not add a new embedding field in Sprint 1.
- Append metadata terms to the existing `combined` text bundle when metadata rows are present.

### 4.6 Pair Compatibility

Build this only in Sprint 3 and only for pruned candidate sets. Do not generate every possible pair by default.

```sql
CREATE TABLE segment_pair_compatibility (
  left_segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  right_segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  pair_type TEXT NOT NULL CHECK (
    pair_type IN ('axis_continuity', 'shot_reverse', 'match_cut', 'dissolve', 'hard_cut', 'breathing_room')
  ),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  recommended_transition_type TEXT CHECK (
    recommended_transition_type IS NULL OR recommended_transition_type IN ('cut', 'crossfade', 'match_cut')
  ),
  risk_level TEXT NOT NULL DEFAULT 'unknown' CHECK (
    risk_level IN ('none', 'low', 'medium', 'high', 'unknown')
  ),
  risk_reason TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  risk_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (left_segment_id, right_segment_id, pair_type)
);

CREATE INDEX idx_segment_pair_type_score
  ON segment_pair_compatibility(pair_type, score DESC);

CREATE INDEX idx_segment_pair_right_type
  ON segment_pair_compatibility(right_segment_id, pair_type, score DESC);
```

Pruning rules:

- `axis_continuity`: same scene or same source-near/action-near segments only.
- `shot_reverse`: user-confirmed same scene or high-confidence subject geometry only.
- `match_cut`: top visual similarity candidates only after frame analysis exists.
- `dissolve`: low/medium motion, compatible tone, sufficient handles.
- `breathing_room`: calm/wide/low-motion candidates near weak adjacent sequences.

## 5. TypeScript Interface Additions

Extend the existing interfaces in `runtime/tools/footage-search.ts` additively.

```ts
export type CameraMotionType =
  | "static"
  | "pan"
  | "tilt"
  | "push_in"
  | "pull_out"
  | "tracking"
  | "handheld"
  | "reveal"
  | "fast_action"
  | "mixed"
  | "unknown";

export type ScreenMotionDirection =
  | "none"
  | "ltr"
  | "rtl"
  | "up"
  | "down"
  | "toward_camera"
  | "away_camera"
  | "mixed"
  | "unknown";

export type CameraStability = "stable" | "slight" | "shaky" | "unknown";

export type UnifiedShotScale =
  | "extreme_wide"
  | "wide"
  | "medium_wide"
  | "medium"
  | "medium_close"
  | "close"
  | "extreme_close"
  | "detail"
  | "unknown";

export type SubjectScreenSide = "left" | "center" | "right" | "mixed" | "none" | "unknown";
export type DominantSubjectType = "person" | "group" | "object" | "vehicle" | "environment" | "none" | "unknown";
export type SubjectMovementDirection = "ltr" | "rtl" | "toward_camera" | "away_camera" | "static" | "mixed" | "unknown";
export type ExposureLabel = "under" | "normal" | "over" | "mixed" | "unknown";
export type ColorTemperature = "warm" | "neutral" | "cool" | "mixed" | "unknown";
export type ContrastLabel = "low" | "normal" | "high" | "mixed" | "unknown";
export type SaturationLabel = "muted" | "normal" | "vivid" | "mixed" | "unknown";
export type AudioRole = "dialogue" | "music" | "ambient" | "silence" | "mixed" | "unknown";
export type SegmentPairType = "axis_continuity" | "shot_reverse" | "match_cut" | "dissolve" | "hard_cut" | "breathing_room";

export interface FootageSearchFilters {
  // Existing fields stay unchanged.

  video_codec?: string;
  recording_format?: string;
  frame_rate_mode?: "cfr" | "vfr" | "audio_only" | "unknown";
  min_width?: number;
  min_height?: number;
  color_primaries?: string;
  color_transfer?: string;
  reel_name?: string;
  card_id?: string;
  camera_id?: string;

  camera_motion_type?: CameraMotionType | CameraMotionType[];
  camera_motion_direction?: ScreenMotionDirection | ScreenMotionDirection[];
  camera_stability?: CameraStability | CameraStability[];
  motion_energy_min?: number;
  motion_energy_max?: number;
  camera_motion_energy_max?: number;

  shot_scale?: UnifiedShotScale | UnifiedShotScale[];
  composition_anchor?: "left" | "center_left" | "center" | "center_right" | "right" | "unknown";
  subject_screen_side?: SubjectScreenSide | SubjectScreenSide[];
  dominant_subject_type?: DominantSubjectType | DominantSubjectType[];
  subject_movement_direction?: SubjectMovementDirection | SubjectMovementDirection[];

  exposure_label?: ExposureLabel | ExposureLabel[];
  color_temperature?: ColorTemperature | ColorTemperature[];
  contrast_label?: ContrastLabel | ContrastLabel[];
  saturation_label?: SaturationLabel | SaturationLabel[];
  dominant_color_any?: string[];

  audio_role?: AudioRole | AudioRole[];
  has_music?: boolean;
  has_ambient?: boolean;
  peak_dbfs_max?: number;
  integrated_lufs_min?: number;
  integrated_lufs_max?: number;
  silence_ratio_min?: number;
  silence_ratio_max?: number;
  silence_head_min_us?: number;
  silence_tail_min_us?: number;
  noise_flags_exclude?: string[];

  scene_number?: string;
  shot_number?: string;
  take_number?: string;
  circle_take?: boolean;
  best_take?: boolean;
  custom_tags_any?: string[];

  pair_with_segment_id?: string;
  pair_type?: SegmentPairType;
  min_pair_score?: number;
  max_pair_risk?: "none" | "low" | "medium" | "high" | "unknown";

  min_metadata_confidence?: number;
}
```

Extend `FootageEvidenceRef.field`:

```ts
export interface FootageEvidenceRef {
  field:
    // existing values
    | "asset_technical"
    | "camera_motion"
    | "shot_scale"
    | "subject_position"
    | "subject_motion"
    | "color_profile"
    | "audio_profile"
    | "logging_profile"
    | "pair_compatibility";
  value: string;
  score?: number;
}
```

Extend `FootageSearchResult` with optional compact metadata. Keep it optional so old DBs and JSON fallback results remain valid.

```ts
export interface FootageSearchResult {
  // Existing fields stay unchanged.

  technical?: {
    video_codec?: string;
    recording_format?: string;
    width?: number;
    height?: number;
    fps_num?: number;
    fps_den?: number;
    frame_rate_mode?: "cfr" | "vfr" | "audio_only" | "unknown";
    color_primaries?: string;
    color_transfer?: string;
    rotation?: 0 | 90 | 180 | 270;
    reel_name?: string;
    card_id?: string;
    camera_id?: string;
  };

  visual_profile?: {
    camera_motion_description?: string;
    camera_motion_type: CameraMotionType;
    camera_motion_direction: ScreenMotionDirection;
    camera_stability: CameraStability;
    motion_energy?: number;
    camera_motion_energy?: number;
    shot_scale: UnifiedShotScale;
    composition_anchor?: "left" | "center_left" | "center" | "center_right" | "right" | "unknown";
    subject_screen_side?: SubjectScreenSide;
    dominant_subject_type?: DominantSubjectType;
    subject_movement_direction?: SubjectMovementDirection;
    exposure_label?: ExposureLabel;
    color_temperature?: ColorTemperature;
    contrast_label?: ContrastLabel;
    saturation_label?: SaturationLabel;
    dominant_colors?: Array<{ color: string; pct?: number }>;
    confidence?: {
      motion?: number;
      scale?: number;
      subject?: number;
      color?: number;
      depth?: number;
    };
  };

  audio_profile?: {
    audio_role: AudioRole;
    has_dialogue: boolean;
    has_music: boolean;
    has_ambient: boolean;
    peak_dbfs?: number;
    rms_dbfs?: number;
    integrated_lufs?: number;
    silence_ratio?: number;
    silence_head_us?: number;
    silence_tail_us?: number;
    noise_flags: string[];
    confidence?: number;
  };

  logging_profile?: {
    scene_number?: string;
    shot_number?: string;
    take_number?: string;
    camera_id?: string;
    card_id?: string;
    circle_take?: boolean;
    best_take?: boolean;
    custom_tags: string[];
    operator_notes?: string;
  };

  pair_match?: {
    anchor_segment_id: string;
    pair_type: SegmentPairType;
    score: number;
    risk_level: "none" | "low" | "medium" | "high" | "unknown";
    reason: string;
  };
}
```

Extend `BuildFootageDbResult.counts` and build report:

```ts
counts: {
  assets: number;
  segments: number;
  fts_rows: number;
  marlin_events: number;
  transcript_segments: number;
  embeddings: number;
  asset_technical_metadata: number;
  segment_visual_profiles: number;
  segment_audio_profiles: number;
  segment_logging_profiles: number;
  segment_pair_compatibility: number;
}
```

Build report status additions:

```json
{
  "metadata_status": "partial",
  "metadata_schema_version": "1",
  "metadata_sources": {
    "ffprobe_extended": { "assets": 12 },
    "marlin_phrase_parser": { "segments": 8, "events": 11 },
    "ffmpeg_audio_analysis": { "segments": 89 },
    "frame_stats": { "segments": 0 },
    "user_annotations": { "segments": 0 }
  },
  "warnings": [
    "metadata: frame_stats skipped; original media unavailable",
    "metadata: depth_of_field indexed as unknown for all segments"
  ]
}
```

Allowed `metadata_status`:

- `ready`: all enabled metadata extractors completed.
- `partial`: at least one useful metadata table was populated and optional extractors skipped.
- `skipped`: metadata extraction disabled.
- `unavailable`: required source media or analysis files unavailable.
- `error`: an enabled required extractor failed.

## 6. Extraction Strategy By Field

### 6.1 Now: Marlin, ffprobe, existing artifacts, ffmpeg filters

`runtime/connectors/marlin-types.ts` provides asset-level `scene`, optional `caption`, and temporal `events[]` with start/end, description, confidence, source pass, chunk index, and chunk offset. Use Marlin only for explicit semantic descriptions and event windows.

`runtime/connectors/ffprobe.ts` currently parses `format`, `streams`, duration, first video stream, first audio stream, and source fingerprint. The raw ffprobe output already contains more keys through index signatures, so the builder can normalize an allowlist without changing canonical artifacts.

Audio levels require `ffmpeg`, not ffprobe alone.

| Field | Sprint | Source | Reliability policy |
| --- | --- | --- | --- |
| `container_format`, `container_long_name` | 1 | `probe.format.format_name`, `format_long_name` | High. Store raw normalized strings. |
| `video_codec`, `video_profile`, `codec_tag` | 1 | first video stream `codec_name`, `profile`, `codec_tag_string` | High when stream exists. Null for audio-only. |
| `width`, `height` | 1 | first video stream | High. Already extracted in `video_stream`; index in DB. |
| `fps_num`, `fps_den`, `r_frame_rate`, `time_base` | 1 | stream `avg_frame_rate`, `r_frame_rate`, `time_base` | Medium-high. Preserve raw rate fields for VFR warnings. |
| `frame_rate_mode` | 1 | compare avg/r frame rate and duration/frame count when available | Medium. Use `unknown` if insufficient. |
| `pix_fmt`, `bit_depth` | 1 | `pix_fmt`, `bits_per_raw_sample`, `bits_per_sample` | Medium. Derive bit depth only from explicit stream fields or known pix_fmt suffix. |
| `color_primaries`, `color_transfer`, `color_space`, `color_range` | 1 | ffprobe stream fields | High if present, null if missing. Do not infer creative grade. |
| `rotation` | 1 | stream tags/side data/display matrix | Medium. Normalize only 0/90/180/270. |
| `audio_streams_json` | 1 | all audio streams | High. Include index, codec, sample rate, channels, channel layout, language/title/default when present. |
| `timecode_start`, `timecode_format` | 1 | source manifest first, ffprobe tags second | Medium. Use `inferred` only with explicit basis. |
| `reel_name`, `card_id`, `camera_id` | 1 | manifest/user annotation/configured filename parser | Medium-high when configured. Null otherwise. |
| `camera_motion_description` | 1 | Marlin event/scene phrase | Medium. Store prose only when phrase is explicit. |
| `camera_motion_type`, `camera_motion_direction` | 1 | phrase parser over Marlin descriptions | Medium-low. Cap confidence at 0.65 unless frame analysis confirms. |
| `camera_stability` | 1 | quality flags, Marlin phrases, existing motion quality labels | Medium. `shaky` is safer than `stable`; use `unknown` when not explicit. |
| `motion_energy` | 1 | `peak_analysis.motion_support_score`, Marlin action density | Medium-low. Ranking hint only until optical flow exists. |
| `shot_scale` | 1 | tags/summary/Marlin explicit terms, existing visual labels | Medium-low. Prefer `unknown` over overconfident scale. |
| `audio_role`, `has_dialogue` | 1 | transcript, `segment_type`, VAD/silence, existing tags | Medium-high for dialogue if transcript exists. |
| `peak_dbfs`, `rms_dbfs`, `integrated_lufs` | 1 | ffmpeg `astats`/`ebur128` over segment range | High enough for technical warnings. |
| `silence_ratio`, `silence_head_us`, `silence_tail_us` | 1 | ffmpeg `silencedetect` windows | High with stable thresholds. Store thresholds in `extraction_source_json`. |
| `scene_number`, `shot_number`, `take_number`, `circle_take`, `custom_tags_json` | 1 | user annotation or configured filename/imported log | High when user-sourced. Do not guess. |

### 6.2 Soon: deterministic frame analysis

| Field | Sprint | Source | Reliability policy |
| --- | --- | --- | --- |
| `composition_anchor` | 2 | representative frame subject/object center or existing composition tags | Medium. Use `unknown` when no dominant subject. |
| `subject_screen_side` | 2 | detector/object box center or frame saliency heuristic | Medium. Coarse only. |
| `dominant_subject_type` | 2 | object/person detector plus tags/Marlin fallback | Medium. `environment`/`none` allowed for non-subject B-roll. |
| `subject_movement_direction` | 2 | optical flow or tracked box delta | Medium. Must subtract likely camera motion when possible. |
| `camera_motion_energy` | 2 | homography/optical-flow transform variance | Medium-high for stability and motion intensity. |
| `exposure_label` | 2 | sampled frame luma histogram and clipping pct | High. Deterministic, thresholded. |
| `color_temperature` | 2 | chroma/white-balance heuristic plus sampled palette | Medium. Use broad warm/neutral/cool only. |
| `contrast_label`, `saturation_label` | 2 | luma/chroma percentiles | High enough for search/ranking. |
| `dominant_colors_json` | 2 | sampled frame quantization | Medium-high. Store percentages and sample count. |

### 6.3 Later: new local models or explicit user approval

These are not Sprint 1/2 commitments.

| Deferred field | Why deferred | Storage policy |
| --- | --- | --- |
| Face direction | Needs face/head pose, fails on small/occluded subjects | Add only after local face/pose model validation. |
| Eyeline direction and eyeline height | High false-positive risk in documentary/B-roll | Pair compatibility can use it later, never rough-cut hard gates. |
| Body pose and gesture phase | Needs pose landmarks | Optional local model, project-local, redactable. |
| Precise depth of field | Needs blur/depth/semantic separation | `depth_of_field` stays `unknown` until reliable. |
| Subject identity/person re-ID | Privacy-sensitive and error-prone | User opt-in only; DB should work with anonymous refs. |
| Wardrobe/narrative day | Useful but model-heavy and project-specific | User annotation or later local visual signature, not Sprint 1. |

## 7. Field Review Matrix

This answers the requested review criteria for each accepted metadata field group.

| Field/group | Helps cut decisions? | Reliable without false positives? | Minimal DB addition? | Search integration |
| --- | --- | --- | --- | --- |
| `video_codec`, `recording_format` | Medium: avoids incompatible/problem footage and export surprises | Yes from ffprobe | Yes, asset side table | Structured filters and technical evidence refs |
| `width`, `height` | Medium: delivery and proxy/render quality checks | Yes | Yes | `min_width`, `min_height` |
| `fps_num`, `fps_den`, `frame_rate_mode` | Medium: flags VFR or rate mismatch before handoff | Mostly; VFR detection may be `unknown` | Yes | `frame_rate_mode` filter and warnings |
| `color_primaries`, `color_transfer`, `color_space` | Low-medium: grade/conform compatibility, not creative matching | Yes when present, absent often | Yes | Technical filters, not rough-cut ranking |
| `rotation` | Medium: prevents bad preview/export orientation | Medium; normalize only explicit rotations | Yes | Warning/evidence, rarely a search filter |
| `audio_streams_json` | Medium: avoids channel surprises | Yes | JSON side field avoids channel table now | Result evidence and future export checks |
| `timecode_start`, `reel_name`, `card_id` | Low for rough cut, high for handoff | Reliable only with manifest/user/parser | Yes | Optional production filters |
| `camera_motion_description` | High: helps choose matching/contrasting motion | Medium from explicit Marlin phrases | Yes | Metadata FTS and evidence refs |
| `camera_motion_type` | High: movement continuity, rest/impact, transition choice | Medium from Marlin, better with frame analysis | Yes | `camera_motion_type` filter |
| `camera_motion_direction` | High for continuity | Low-medium until optical flow | Yes | Use as ranking hint unless confidence threshold set |
| `camera_stability` | High: shaky vs stable changes edit feel | Medium now; high after transform variance | Yes | `camera_stability`, exclude shaky |
| `motion_energy` | High: pacing and breathing room | Medium now, better soon | Yes | min/max filters and scoring |
| `camera_motion_energy` | High: separates camera motion from subject action | Needs frame analysis | Yes | Sprint 2 filter/ranking |
| `shot_scale` | Very high: scale progression and jump-cut avoidance | Medium now, high after frame analysis | Yes | `shot_scale` filter and result profile |
| `composition_anchor` | Medium-high: match/contrast and frame balance | Needs frame analysis | Yes | `composition_anchor` filter |
| `subject_screen_side` | High for 180-degree support | Needs frame analysis; coarse only | Yes | screen-side filters and pair scoring |
| `dominant_subject_type` | Medium: distinguishes people, objects, environments | Medium with tags/detectors | Yes | subject-type filters |
| `subject_movement_direction` | High for action continuity | Needs tracking/flow | Yes | direction filters and pair scoring |
| `exposure_label` | High: avoids unusable and mismatched shots | High with histograms | Yes | exposure filters and warnings |
| `color_temperature` | Medium: visual continuity/mood | Medium with broad labels | Yes | warm/cool search |
| `contrast_label`, `saturation_label` | Medium: visual continuity | High with frame stats | Yes | tone filters |
| `dominant_colors_json` | Medium: palette/brand/detail matching | Medium-high with sample count | JSON side field is enough | `dominant_color_any` post-filter |
| `depth_of_field` | Medium but not next-run critical | No, not reliable now | Column exists but defaults unknown | Do not hard-filter until later |
| `audio_role` | High: A-roll/B-roll/nat-sound separation | Medium-high with transcript/silence | Yes | `audio_role` filter |
| `has_dialogue`, `has_music`, `has_ambient` | High: avoids accidental audio conflicts | Dialogue high, music/ambient medium | Yes | existing and new boolean filters |
| `peak_dbfs`, `rms_dbfs`, `integrated_lufs` | High for usable dialogue and audio bridges | High via ffmpeg filters | Yes | level filters and warnings |
| `silence_ratio`, head/tail silence | High for room tone, J/L-cut readiness later | High with thresholds | Yes | silence filters |
| `noise_flags_json` | Medium-high for A-roll quality | Deterministic clipping yes, wind/hum later | JSON field keeps it scoped | exclude flags |
| `scene_number`, `shot_number`, `take_number` | High when user logs exist | High if annotated, otherwise null | Yes | production filters |
| `circle_take`, `best_take` | High selection signal | High only from user/imported logs | Yes | direct filters and ranking boost |
| `custom_tags_json`, `operator_notes` | Medium-high: project-specific retrieval | High when user-sourced | Yes | metadata FTS and `custom_tags_any` |
| `segment_pair_compatibility` | High for fine-cut repair | Medium after frame/pair evidence | Separate optional table | `pair_with_segment_id`, `pair_type`, `min_pair_score` |

## 8. Search Queries Enabled

The public surface remains `search_footage(query, mode, filters_json, limit)`. The metadata layer expands `filters_json`; it does not require new public tools.

### 8.1 Stable close-up after a fast camera move

```json
{
  "query": "steady close reaction after fast motion",
  "mode": "hybrid",
  "filters": {
    "shot_scale": ["medium_close", "close"],
    "camera_stability": "stable",
    "motion_energy_max": 0.35,
    "exclude_quality_flags": ["blur", "overexposed"]
  },
  "limit": 12
}
```

### 8.2 Warm, dialogue-free B-roll

```json
{
  "query": "warm indoor cutaway without dialogue",
  "mode": "hybrid",
  "filters": {
    "color_temperature": "warm",
    "exposure_label": "normal",
    "has_dialogue": false,
    "audio_role": ["ambient", "silence"],
    "shot_scale": ["wide", "medium_wide", "medium", "detail"]
  },
  "limit": 12
}
```

### 8.3 Find shaky or VFR footage before final render

```json
{
  "query": "technical risk check",
  "mode": "structured",
  "filters": {
    "frame_rate_mode": "vfr",
    "camera_stability": "shaky"
  },
  "limit": 50
}
```

Implementation should treat multiple risk filters as OR only if the caller explicitly requests an audit mode. Normal structured filters are AND.

### 8.4 Find circle takes from a logged scene

```json
{
  "query": "circle takes for scene 03",
  "mode": "structured",
  "filters": {
    "scene_number": "03",
    "circle_take": true
  },
  "limit": 20
}
```

### 8.5 Find a pair-compatible replacement

Sprint 3 only:

```json
{
  "query": "replacement that preserves movement continuity",
  "mode": "structured",
  "filters": {
    "pair_with_segment_id": "SEG_0012",
    "pair_type": "axis_continuity",
    "min_pair_score": 0.7,
    "max_pair_risk": "low",
    "exclude_segment_ids": ["SEG_0012"]
  },
  "limit": 8
}
```

## 9. Builder Integration

Implementation path in `runtime/artifacts/footage-db-builder.ts`:

1. Add the DDL tables above to the temp DB build.
2. Load optional metadata sources without blocking the base DB:
   - original media via `source_locator` when available
   - ffprobe raw output if rerun is enabled
   - `03_analysis/marlin_events.json`
   - transcripts and existing segment fields
   - optional `03_analysis/footage_user_annotations.json`
3. Populate tables in this order:
   - base v1 tables
   - `asset_technical_metadata`
   - `segment_visual_profile`
   - `segment_audio_profile`
   - `segment_logging_profile`
   - `segment_metadata_fts`
   - embeddings `combined` text with metadata terms
   - optional `segment_pair_compatibility`
4. Write counts and warnings to `footage-db-build-report.json`.
5. Keep atomic replacement and `PRAGMA integrity_check`.

Suggested optional annotation sidecar:

```json
{
  "artifact_version": "footage-user-annotations-v1",
  "items": [
    {
      "asset_id": "AST_EXAMPLE",
      "segment_id": null,
      "scene_number": "03",
      "shot_number": "02",
      "take_number": "04",
      "camera_id": "A",
      "circle_take": true,
      "custom_tags": ["interview", "best reaction"],
      "operator_notes": "Use this take if the delivery lands."
    }
  ]
}
```

The sidecar is an input to the derived DB, not a canonical planning artifact.

## 10. Search Integration

Implementation path in `runtime/tools/footage-search.ts`:

1. Detect metadata table availability with `sqlite_master`.
2. Add optional left joins only when filters or result enrichment need them.
3. If a requested metadata filter table is missing, return a warning and avoid fabricating matches.
4. Apply `min_metadata_confidence` only to the relevant field group:
   - motion filters check `motion_confidence`
   - shot scale checks `scale_confidence`
   - subject filters check `subject_confidence`
   - color filters check `color_confidence`
   - audio filters check `segment_audio_profile.confidence`
5. Keep JSON field filters in TypeScript post-filtering unless JSON1 usage is already established for the DB driver.
6. Add metadata evidence refs to `match_reason`.
7. Preserve direct JSON fallback when DB is missing or malformed. Fallback does not need to emulate all metadata filters; it should warn that metadata filters require `footage.db`.

Ranking suggestions:

- Boost `circle_take` and `best_take` only when explicitly present.
- Do not penalize unknown face/gaze/depth fields in rough cut.
- Treat low-confidence motion/direction as a weak score, not a hard continuity decision.
- For `shot_scale`, exact scale match helps replacement; scale contrast may help progression. The caller intent should decide.

## 11. Sprint Plan

### Sprint 1: Extract what the repo can get now

Build:

- `asset_technical_metadata` from ffprobe allowlisted format/stream fields.
- `segment_visual_profile` with Marlin phrase parser, stability hints, basic shot scale, and existing `peak_analysis.motion_support_score`.
- `segment_audio_profile` from transcript/segment type and ffmpeg audio filters.
- `segment_logging_profile` from optional user annotation sidecar and configured filename parser.
- `segment_metadata_fts`.
- Search filters for technical fields, camera stability, camera motion type, shot scale, audio role, audio levels, scene/take/circle/custom tags.

Acceptance:

- Existing projects build and search with metadata disabled or missing.
- `PRAGMA integrity_check` returns `ok`.
- Searching for stable close-ups, dialogue-free B-roll, VFR footage, and circle takes works when data exists.
- Missing original media, ffmpeg audio analysis, or annotations produces warnings, not failed base DB builds.
- No files outside `docs/` are changed for this design task; implementation later stays out of canonical schemas.

### Sprint 2: Add deterministic frame analysis

Build:

- Sample frames per segment.
- Compute exposure, contrast, saturation, dominant colors.
- Compute coarse composition anchor and subject screen side when a dominant object/person can be detected.
- Compute camera/subject motion energy through optical flow or transform variance.
- Improve shot scale classification with frame-derived evidence.

Acceptance:

- Repeated builds over fixed fixture media produce stable values.
- Low-confidence subject position remains `unknown`.
- Motion energy does not mistake obvious camera motion for subject movement without marking `camera_motion_energy`.
- Visual filters enrich ranking but do not break old text/structured search.

### Sprint 3: Targeted pair compatibility

Build:

- Generate pruned `segment_pair_compatibility` rows for candidate pairs only.
- Add search filters `pair_with_segment_id`, `pair_type`, `min_pair_score`, `max_pair_risk`.
- Use pair rows in fine-cut repair and review reports, not as rough-cut hard blockers.

Acceptance:

- Pair generation is bounded and deterministic.
- Search-derived replacement suggestions cite the anchor segment, pair type, score, risk, and evidence refs.
- Axis and shot-reverse warnings remain warnings unless user annotation confirms a rule.
- No public tool proliferation is required; `search_footage` remains the main API.

## 12. Concerns And Guardrails

### Over-engineering risk

The risk is building a partial NLE database instead of a rough-cut retrieval layer.

Guardrails:

- Keep metadata segment-level until a concrete fine-cut repair needs pair rows.
- Do not store full raw ffprobe/ExifTool/MediaInfo dumps in primary tables.
- Do not add lens, camera-original package graphs, proxy management, or full conform mapping in this addendum.
- Do not promote `similar_to`, `unused_footage`, or `best_for_beat` further because the live code already exposes them. Metadata should enrich the same search path.

### Extraction accuracy risk

Noisy geometry can hurt more than missing geometry.

Guardrails:

- Marlin phrase parsing is evidence, not geometry. Confidence cap: 0.65 unless frame analysis confirms it.
- `unknown` is a valid and common value.
- Search must not treat unknown as matching concrete values.
- Face direction, body pose, eyeline, identity, and precise depth are deferred.
- Every result should expose confidence/evidence when metadata influenced ranking.

### Scope creep risk

The next pipeline run needs better rough-cut selection, not polish-grade spatial continuity.

Guardrails:

- Sprint 1 focuses on codec/resolution, stability, basic shot scale, audio levels, and annotations.
- Sprint 2 focuses on deterministic frame stats.
- Sprint 3 adds pair rows only for targeted fine-cut repairs.
- Full line-of-action modeling, match-cut polish, pose models, and identity matching are later.

## 13. Verification Strategy

Doc-driven implementation should verify:

- DDL applies cleanly to an empty temp DB.
- `PRAGMA integrity_check` returns `ok`.
- Base v1 search still works when all metadata tables are absent.
- Requested metadata filters return warnings when the table is missing.
- ffprobe fixtures populate codec, resolution, frame rate, color tags, rotation, and audio stream JSON.
- ffmpeg audio fixtures populate peak/RMS/LUFS and silence windows deterministically.
- Marlin phrase fixtures only classify explicit camera movement phrases.
- Frame-stat fixtures produce stable exposure/color labels.
- Annotation fixtures map scene/shot/take/circle/custom tags into search results.
- Pair compatibility fixtures are bounded and deterministic.

Manual check commands after implementation:

```bash
npm run build
npx vitest run tests/footage-db.test.ts tests/editorial-tools.test.ts
npx tsx scripts/build-footage-db.ts --project projects/<id> --embedding-policy skip
sqlite3 projects/<id>/03_analysis/search/footage.db 'PRAGMA integrity_check;'
sqlite3 projects/<id>/03_analysis/search/footage.db 'SELECT COUNT(*) FROM segment_visual_profile;'
```

## 14. Summary

Build the metadata layer as a conservative `footage.db` addendum:

- Sprint 1: technical facts, Marlin-derived motion hints, stability, basic shot scale, audio levels, and user annotations.
- Sprint 2: deterministic frame stats for subject position, shot scale, motion energy, and color continuity.
- Sprint 3: pruned pair compatibility for fine-cut repairs.

This is enough to make `search_footage` choose better cuts without turning the derived DB into a full NLE, and without adding noisy model guesses to canonical project artifacts.
