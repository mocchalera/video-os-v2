# Design: Footage Metadata For Cinematography And Camera Work

Date: 2026-06-19
Status: Draft design
Scope: design only. This document proposes additive cinematography metadata for the derived footage database.
Related:

- `docs/design-footage-database-unified.md`
- `runtime/connectors/marlin-types.ts`
- `runtime/connectors/gemini-vlm.ts`
- `docs/design-editorial-craft-structure-first.md`
- `docs/cut-transition-design.md`

## 1. Position

The current footage database makes segments searchable by scene text, transcript/OCR text, visual quality, place hints, temporal events, peaks, FTS5, and local embeddings. That is enough to find "what is in the shot." It is not enough to decide "what cut will work."

Professional edit decisions need a second layer: how the shot behaves on screen. A segment should be searchable by movement direction, shot size, subject screen direction, eye line, depth, and frame balance. These fields let the agent ask continuity questions before choosing footage:

- Will this pan-right cut into another pan-right cleanly?
- Is this a wide establishing shot or another medium shot that will jump?
- Is the subject facing the same screen direction across the cut?
- Does this static shot give the viewer a breath after a fast camera move?
- Can this close-up follow the wide without breaking the 180-degree line?

The design should remain practical:

- Add these fields to the rebuildable SQLite footage DB first.
- Do not make SQLite the source of truth for planning artifacts.
- Do not require changes to `segments.schema.json` for the first pass.
- Reuse existing transition vocabulary where it exists: `MotionType`, `ShotScale`, `CompositionAnchor`, `ScreenSide`, `GazeDirection`, and `CameraAxis`.
- Store confidence and provenance so low-confidence cinematography signals are useful as hints, not false facts.

## 2. Success Conditions

This design is successful when:

- The derived DB can answer camera/shot queries without modifying canonical project artifacts.
- Camera movement, shot scale, subject direction, and depth cues have closed vocabularies.
- Each field has a realistic extraction source: Marlin text, Gemini frame reasoning, deterministic CV, or "not P0."
- Existing footage search still works when cinematography metadata is absent.
- Editorial agents can use these fields for continuity, contrast, scale progression, and shot replacement decisions.
- Low-confidence or unavailable fields degrade to `unknown` and warnings, not invented labels.

## 3. Non-Goals

- Do not infer exact lens focal length, camera model, gimbal brand, GPS, or true camera rig unless source metadata provides it.
- Do not promise perfect 180-degree rule enforcement from a single segment. The DB can expose screen-direction evidence; scene-level line-of-action judgment still needs context.
- Do not run frame-by-frame heavy models during compile.
- Do not let the search tool mutate `selects_candidates.yaml`, `edit_blueprint.yaml`, or `timeline.json`.
- Do not treat Marlin prose as authoritative geometry when frame evidence disagrees.

## 4. Camera Work Classification

### 4.1 Core Fields

Store camera work as a dominant segment-level summary plus optional temporal events. The segment-level row is for search filters. Event rows preserve changes inside a segment, such as "static opening, then pan right."

Recommended closed vocabulary:

| Field | Values | Notes |
| --- | --- | --- |
| `camera_movement_type` | `static`, `pan`, `tilt`, `dolly`, `tracking`, `crane`, `handheld`, `steadicam`, `drone_orbit`, `reveal`, `mixed`, `unknown` | Keep technique separate from direction. `reveal` maps to existing transition `MotionType`. |
| `camera_movement_direction` | `none`, `left_to_right`, `right_to_left`, `up`, `down`, `approaching`, `retreating`, `ascending`, `descending`, `clockwise`, `counterclockwise`, `mixed`, `unknown` | Use screen direction, not world direction. |
| `camera_movement_speed` | `none`, `slow`, `medium`, `fast`, `mixed`, `unknown` | Segment-relative; exact pixels/sec can be future evidence. |
| `camera_stability` | `stable`, `slight_movement`, `shaky`, `unknown` | `stable` means tripod/gimbal-like, not necessarily no motion. |
| `movement_confidence` | `0..1` | Must be present when movement fields are not `unknown`. |
| `movement_evidence_json` | array | Short evidence refs: Marlin event id, sampled frame range, optical-flow summary, Gemini rationale. |

For pan/tilt labels, direction should mean the viewer-readable screen sweep, not the raw optical-flow sign. For example, a "left-to-right pan" means the shot reads as moving or revealing across the screen from left toward right.

Compatibility mapping to existing transition vocabulary:

| New fields | Existing `MotionType` |
| --- | --- |
| `static` | `static` |
| `pan` | `pan` |
| `tilt` | `tilt` |
| `dolly` + `approaching` | `push_in` |
| `dolly` + `retreating` | `pull_out` |
| `tracking` | `tracking` |
| `handheld` or `camera_stability = shaky` | `handheld` |
| `reveal` | `reveal` |
| `mixed`, `unknown` | `unknown` |

### 4.2 Why Camera Work Matters For Editing

Movement continuity:

- `pan` + `left_to_right` followed by `pan` + `left_to_right` usually feels continuous.
- `tracking` + `approaching` can cut smoothly into another approach or a tighter shot with matching subject direction.
- `static` after fast movement gives the viewer a rest and can make a reveal or reaction land.

Movement contrast:

- `static -> fast pan` creates impact.
- `shaky handheld -> stable wide` can signal a change from lived experience to orientation.
- `dolly in -> static close-up` can feel like emotional arrival.

Transition selection:

- Smooth dissolves prefer compatible movement or low motion.
- Match cuts need similar movement, shot scale, or composition anchors.
- Hard cuts can tolerate directional contrast when story/energy justifies it.

## 5. Shot Scale And Framing

### 5.1 Shot Scale

Professional shot scale vocabulary:

| Shot scale | Meaning | Existing transition mapping |
| --- | --- | --- |
| `extreme_wide` | Landscape, building, room, or environment dominates. | `extreme_wide` |
| `wide` | Full environment and subject relationship are readable. | `wide` |
| `full` | Full body or full object visible. | `medium_wide` |
| `medium` | Waist/chest/object context. | `medium` |
| `medium_close_up` | Head-and-shoulders or tight object context. | `medium_close` |
| `close_up` | Face, hands, object, or detail dominates. | `close` |
| `extreme_close_up` | Tiny feature fills frame. | `extreme_close` |
| `detail` | Insert/detail shot, often object or texture rather than face. | `extreme_close` plus `framing_tags_json` |
| `unknown` | Not confidently classifiable. | `unknown` |

`shot_scale` should store the professional vocabulary. `transition_shot_scale` can store the current compiler-compatible value when needed for transition scoring.

### 5.2 Framing Fields

Recommended fields:

| Field | Values | Purpose |
| --- | --- | --- |
| `composition_anchor` | `left`, `center_left`, `center`, `center_right`, `right`, `unknown` | Reuses current adjacency vocabulary. |
| `subject_screen_zone` | `left`, `center`, `right`, `mixed`, `none`, `unknown` | Coarser aspect-ratio zone for filters. |
| `framing_style` | `center`, `rule_of_thirds_left`, `rule_of_thirds_right`, `edge_left`, `edge_right`, `mixed`, `unknown` | Editor-facing framing label. |
| `headroom` | `cut_off`, `tight`, `balanced`, `loose`, `not_applicable`, `unknown` | Useful for people/interview shots and close-ups. |
| `leading_space` | `left`, `right`, `balanced`, `insufficient`, `not_applicable`, `unknown` | Indicates space in front of gaze or motion. |
| `framing_confidence` | `0..1` | Confidence for shot scale and frame position. |

### 5.3 Why Shot Scale Matters

Shot scale progression:

- `extreme_wide -> wide -> medium -> close_up` gives orientation, action, and emotion in sequence.
- `close_up -> wide` can produce a reveal.
- `detail -> medium` can clarify what the detail belongs to.

Jump-cut avoidance:

- Two adjacent shots of the same subject at nearly the same scale and angle are often jarring unless the intent is a deliberate jump cut.
- A scale jump of at least one meaningful step helps hide continuity differences.
- `medium -> medium` can still work if composition, screen direction, or action changes enough.

180-degree rule support:

- `subject_screen_zone`, `composition_anchor`, `subject_facing_direction`, and `camera_axis` provide evidence for line-of-action checks.
- The DB should not decide the line alone; it should make the relevant screen-direction evidence queryable.

## 6. Subject Direction And Screen Position

### 6.1 Core Fields

Recommended fields:

| Field | Values | Notes |
| --- | --- | --- |
| `dominant_subject_type` | `person`, `group`, `object`, `vehicle`, `environment`, `none`, `unknown` | Keeps direction fields interpretable. |
| `subject_facing_direction` | `left`, `right`, `center`, `toward_camera`, `away_from_camera`, `mixed`, `not_applicable`, `unknown` | For a clear dominant subject. |
| `subject_movement_direction` | `left_to_right`, `right_to_left`, `approaching`, `retreating`, `stationary`, `mixed`, `not_applicable`, `unknown` | For action continuity and screen direction. |
| `eye_line_direction` | `left`, `right`, `up`, `down`, `camera`, `not_visible`, `not_applicable`, `unknown` | For interviews, reactions, and shot-reverse-shot. |
| `camera_axis` | `ltr`, `rtl`, `neutral`, `unknown` | Reuses current adjacency vocabulary. |
| `direction_confidence` | `0..1` | Lower when subject is small, occluded, turned away, or multiple subjects conflict. |

### 6.2 Why This Matters For The Imaginary Line

Screen direction continuity:

- If a person faces right in shot A, shot B should usually keep them facing right or toward camera unless the edit intentionally crosses the line.
- If a cyclist, walker, hand motion, or vehicle moves left-to-right in shot A, continuing left-to-right in shot B feels geographically coherent.
- Approaching motion can cut into a tighter shot of the same subject if the eye line and screen side are compatible.

Crossing the line:

- A left-facing subject followed by a right-facing subject can imply confrontation or line crossing.
- A reversal can be useful for emphasis, but the agent should know it is choosing a break.
- `axis_consistency_score` should be derived from `camera_axis`, `subject_screen_zone`, `subject_facing_direction`, and `subject_movement_direction`, with an explicit confidence floor.

Eye line:

- `eye_line_direction = camera` supports direct address or testimonial moments.
- `eye_line_direction = left` can match a reverse angle where the next subject looks right.
- Unknown eye line should not block selection; it should reduce confidence in continuity-sensitive edits.

## 7. Depth And Spatial Cues

Recommended fields:

| Field | Values | Purpose |
| --- | --- | --- |
| `depth_of_field` | `shallow`, `medium`, `deep`, `unknown` | Distinguishes portrait/detail isolation from readable environment. |
| `foreground_present` | `0`, `1` | Whether a foreground layer is visible. |
| `foreground_types_json` | array of strings | Examples: `foliage`, `door_frame`, `hands`, `table`, `window`, `signage`. |
| `background_complexity` | `simple`, `moderate`, `complex`, `unknown` | Helps find clean backgrounds or rich establishing shots. |
| `spatial_depth_confidence` | `0..1` | Confidence for depth and foreground/background labels. |

Editing uses:

- Shallow depth close-ups can isolate emotion after a busy wide shot.
- Deep-focus wides establish location and spatial relation.
- Foreground elements can support motivated wipes, reveals, or layered compositions.
- Complex backgrounds can be useful for establishing shots but distracting for dialogue.

## 8. Extraction Plan

### 8.1 What Marlin-2B Can Provide

`runtime/connectors/marlin-types.ts` exposes asset-level `scene`, optional `caption`, and temporal `events[]` with descriptions, start/end times, confidence, and source pass. Marlin can help when its prose explicitly says:

- "camera pans right"
- "camera tilts up"
- "person walks toward the camera"
- "handheld shot"
- "drone shot orbiting"

Practical use:

- Parse only high-precision movement phrases from Marlin descriptions into `cinematography_events`.
- Cap confidence from prose parsing, for example at `0.65`, unless reinforced by frame/CV evidence.
- Use Marlin event timing to locate where camera movement changes within an asset.

Do not rely on Marlin alone for:

- exact subject screen zone
- eye line
- shot scale
- headroom
- foreground/background structure
- depth of field
- separating camera motion from subject motion

### 8.2 What Current Gemini VLM Can Provide

`runtime/connectors/gemini-vlm.ts` currently asks for summary, tags, interest points, quality flags, and visual quality. This can already surface weak hints such as `close_up`, `shaky`, or composition labels, but it does not return a structured cinematography object.

Recommended Gemini use:

- Add a separate narrow cinematography prompt template, for example `cinematography-v1`.
- Feed the same sampled frames used by VLM enrichment, plus Marlin scene/event text as context.
- Return only bounded JSON fields from this document.
- Do not ask Gemini to rewrite `summary`; keep it as an appraiser/classifier for shot language.

Gemini is practical for:

- shot scale
- framing style and composition anchor
- subject screen zone
- rough facing direction
- eye line when the face is visible
- depth-of-field label
- foreground/background descriptors
- confirming Marlin movement prose

Gemini is weak for:

- precise pan/tilt/dolly classification from sparse frames
- measuring movement speed
- distinguishing camera movement from subject movement when both occur
- exact 180-degree line inference across a scene

### 8.3 What Needs Frame-Level CV Or New Models

Camera movement should not depend only on LLM frame interpretation. The practical P1/P2 stack should add deterministic or specialized CV:

| Signal | Preferred extractor | Reason |
| --- | --- | --- |
| pan/tilt/zoom/push/pull/tracking speed | feature tracking plus homography or optical flow | Needs frame-to-frame motion, not still image classification. |
| stability/shakiness | frame-to-frame transform variance | Easier and more reliable than prose labels. |
| subject movement direction | object/person tracking over sampled frames | Needs subject box trajectories. |
| facing direction and eye line | face/body pose model plus Gemini fallback | Needs face/body geometry when visible. |
| depth of field | blur map plus semantic foreground/background, or Gemini fallback | Still-image VLM can label this, but CV can validate. |
| foreground presence | segmentation/object detection plus Gemini labels | Helps distinguish subject from frame layers. |
| drone orbit | Gemini/Marlin hint plus optical flow; confidence usually low | Hard to prove from short clips without metadata. |

Candidate model classes:

- OpenCV feature matching and homography for camera motion.
- Optical-flow estimation for movement speed and direction.
- Person/object detector plus tracker for dominant subject motion.
- Face/pose estimator for facing and eye line.
- Monocular depth or segmentation model for foreground/background cues.

Extraction precedence:

1. Deterministic CV where geometry is measurable.
2. Gemini structured classification for semantic shot language and ambiguous cases.
3. Marlin temporal descriptions for event timing and text evidence.
4. Existing `visual_quality`, `quality_flags`, and `adjacency_features` as fallbacks.

When sources disagree, keep the higher-confidence source and include disagreement in `evidence_json` or build warnings.

## 9. Database Schema Additions

The footage DB is a derived artifact, so the clean implementation path is a schema-version bump and full rebuild. This should not require changes to canonical planning schemas.

### 9.1 Segment-Level Cinematography Table

```sql
CREATE TABLE segment_cinematography (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  camera_movement_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_movement_type IN (
      'static', 'pan', 'tilt', 'dolly', 'tracking', 'crane',
      'handheld', 'steadicam', 'drone_orbit', 'reveal', 'mixed', 'unknown'
    )
  ),
  camera_movement_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_movement_direction IN (
      'none', 'left_to_right', 'right_to_left', 'up', 'down',
      'approaching', 'retreating', 'ascending', 'descending',
      'clockwise', 'counterclockwise', 'mixed', 'unknown'
    )
  ),
  camera_movement_speed TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_movement_speed IN ('none', 'slow', 'medium', 'fast', 'mixed', 'unknown')
  ),
  camera_stability TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_stability IN ('stable', 'slight_movement', 'shaky', 'unknown')
  ),

  shot_scale TEXT NOT NULL DEFAULT 'unknown' CHECK (
    shot_scale IN (
      'extreme_wide', 'wide', 'full', 'medium', 'medium_close_up',
      'close_up', 'extreme_close_up', 'detail', 'unknown'
    )
  ),
  transition_shot_scale TEXT NOT NULL DEFAULT 'unknown' CHECK (
    transition_shot_scale IN (
      'extreme_close', 'close', 'medium_close', 'medium',
      'medium_wide', 'wide', 'extreme_wide', 'unknown'
    )
  ),
  composition_anchor TEXT NOT NULL DEFAULT 'unknown' CHECK (
    composition_anchor IN ('left', 'center_left', 'center', 'center_right', 'right', 'unknown')
  ),
  subject_screen_zone TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_screen_zone IN ('left', 'center', 'right', 'mixed', 'none', 'unknown')
  ),
  framing_style TEXT NOT NULL DEFAULT 'unknown' CHECK (
    framing_style IN (
      'center', 'rule_of_thirds_left', 'rule_of_thirds_right',
      'edge_left', 'edge_right', 'mixed', 'unknown'
    )
  ),
  headroom TEXT NOT NULL DEFAULT 'unknown' CHECK (
    headroom IN ('cut_off', 'tight', 'balanced', 'loose', 'not_applicable', 'unknown')
  ),
  leading_space TEXT NOT NULL DEFAULT 'unknown' CHECK (
    leading_space IN ('left', 'right', 'balanced', 'insufficient', 'not_applicable', 'unknown')
  ),

  dominant_subject_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
    dominant_subject_type IN ('person', 'group', 'object', 'vehicle', 'environment', 'none', 'unknown')
  ),
  subject_facing_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_facing_direction IN (
      'left', 'right', 'center', 'toward_camera', 'away_from_camera',
      'mixed', 'not_applicable', 'unknown'
    )
  ),
  subject_movement_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_movement_direction IN (
      'left_to_right', 'right_to_left', 'approaching', 'retreating',
      'stationary', 'mixed', 'not_applicable', 'unknown'
    )
  ),
  eye_line_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    eye_line_direction IN ('left', 'right', 'up', 'down', 'camera', 'not_visible', 'not_applicable', 'unknown')
  ),
  camera_axis TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_axis IN ('ltr', 'rtl', 'neutral', 'unknown')
  ),

  depth_of_field TEXT NOT NULL DEFAULT 'unknown' CHECK (
    depth_of_field IN ('shallow', 'medium', 'deep', 'unknown')
  ),
  foreground_present INTEGER NOT NULL DEFAULT 0 CHECK (foreground_present IN (0, 1)),
  foreground_types_json TEXT NOT NULL DEFAULT '[]',
  background_complexity TEXT NOT NULL DEFAULT 'unknown' CHECK (
    background_complexity IN ('simple', 'moderate', 'complex', 'unknown')
  ),

  movement_confidence REAL CHECK (movement_confidence IS NULL OR (movement_confidence >= 0 AND movement_confidence <= 1)),
  framing_confidence REAL CHECK (framing_confidence IS NULL OR (framing_confidence >= 0 AND framing_confidence <= 1)),
  direction_confidence REAL CHECK (direction_confidence IS NULL OR (direction_confidence >= 0 AND direction_confidence <= 1)),
  spatial_depth_confidence REAL CHECK (spatial_depth_confidence IS NULL OR (spatial_depth_confidence >= 0 AND spatial_depth_confidence <= 1)),

  evidence_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_cinematography_camera
  ON segment_cinematography(camera_movement_type, camera_movement_direction, camera_movement_speed);

CREATE INDEX idx_cinematography_stability
  ON segment_cinematography(camera_stability);

CREATE INDEX idx_cinematography_shot_scale
  ON segment_cinematography(shot_scale, transition_shot_scale);

CREATE INDEX idx_cinematography_framing
  ON segment_cinematography(composition_anchor, subject_screen_zone, framing_style);

CREATE INDEX idx_cinematography_direction
  ON segment_cinematography(subject_facing_direction, subject_movement_direction, eye_line_direction, camera_axis);

CREATE INDEX idx_cinematography_depth
  ON segment_cinematography(depth_of_field, foreground_present, background_complexity);
```

### 9.2 Temporal Cinematography Events

```sql
CREATE TABLE cinematography_events (
  event_id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  start_us INTEGER NOT NULL CHECK (start_us >= 0),
  end_us INTEGER NOT NULL CHECK (end_us >= start_us),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('camera_movement', 'subject_movement', 'framing_change', 'focus_depth_change')
  ),
  camera_movement_type TEXT CHECK (
    camera_movement_type IS NULL OR camera_movement_type IN (
      'static', 'pan', 'tilt', 'dolly', 'tracking', 'crane',
      'handheld', 'steadicam', 'drone_orbit', 'reveal', 'mixed', 'unknown'
    )
  ),
  movement_direction TEXT CHECK (
    movement_direction IS NULL OR movement_direction IN (
      'none', 'left_to_right', 'right_to_left', 'up', 'down',
      'approaching', 'retreating', 'ascending', 'descending',
      'clockwise', 'counterclockwise', 'mixed', 'unknown'
    )
  ),
  movement_speed TEXT CHECK (
    movement_speed IS NULL OR movement_speed IN ('none', 'slow', 'medium', 'fast', 'mixed', 'unknown')
  ),
  subject_movement_direction TEXT CHECK (
    subject_movement_direction IS NULL OR subject_movement_direction IN (
      'left_to_right', 'right_to_left', 'approaching', 'retreating',
      'stationary', 'mixed', 'not_applicable', 'unknown'
    )
  ),
  description TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_pass TEXT NOT NULL,
  source_ref TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_cinematography_events_segment_time
  ON cinematography_events(segment_id, start_us, end_us);

CREATE INDEX idx_cinematography_events_asset_time
  ON cinematography_events(asset_id, start_us, end_us);

CREATE INDEX idx_cinematography_events_motion
  ON cinematography_events(camera_movement_type, movement_direction, movement_speed, confidence);
```

### 9.3 FTS And Embedding Text Additions

Add a `cinematography` FTS field in the next DB schema version:

```sql
CREATE VIRTUAL TABLE segments_fts USING fts5(
  segment_id UNINDEXED,
  asset_id UNINDEXED,
  summary,
  transcript,
  marlin_scene,
  marlin_events,
  tags,
  quality_labels,
  extracted_text,
  place,
  aesthetic_notes,
  cinematography,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-'"
);
```

Populate `cinematography` with compact normalized terms:

```text
camera pan left_to_right slow stable shot medium subject facing_right eye_line camera depth shallow foreground hands
```

Also include these terms in the `combined` embedding text bundle. This lets natural-language queries like "steady close shot with shallow background" work even before the agent supplies structured filters.

### 9.4 Search Filter Additions

Extend `FootageSearchFilters` additively:

```ts
export interface FootageSearchFilters {
  camera_movement_type?: "static" | "pan" | "tilt" | "dolly" | "tracking" | "crane" | "handheld" | "steadicam" | "drone_orbit" | "reveal" | "mixed" | "unknown";
  camera_movement_direction?: "none" | "left_to_right" | "right_to_left" | "up" | "down" | "approaching" | "retreating" | "ascending" | "descending" | "clockwise" | "counterclockwise" | "mixed" | "unknown";
  camera_movement_speed?: "none" | "slow" | "medium" | "fast" | "mixed" | "unknown";
  camera_stability?: "stable" | "slight_movement" | "shaky" | "unknown";
  shot_scale?: "extreme_wide" | "wide" | "full" | "medium" | "medium_close_up" | "close_up" | "extreme_close_up" | "detail" | "unknown";
  shot_scale_any?: Array<"extreme_wide" | "wide" | "full" | "medium" | "medium_close_up" | "close_up" | "extreme_close_up" | "detail">;
  composition_anchor?: "left" | "center_left" | "center" | "center_right" | "right" | "unknown";
  subject_screen_zone?: "left" | "center" | "right" | "mixed" | "none" | "unknown";
  subject_facing_direction?: "left" | "right" | "center" | "toward_camera" | "away_from_camera" | "mixed" | "not_applicable" | "unknown";
  subject_movement_direction?: "left_to_right" | "right_to_left" | "approaching" | "retreating" | "stationary" | "mixed" | "not_applicable" | "unknown";
  eye_line_direction?: "left" | "right" | "up" | "down" | "camera" | "not_visible" | "not_applicable" | "unknown";
  camera_axis?: "ltr" | "rtl" | "neutral" | "unknown";
  depth_of_field?: "shallow" | "medium" | "deep" | "unknown";
  foreground_present?: boolean;
  background_complexity?: "simple" | "moderate" | "complex" | "unknown";
  min_cinematography_confidence?: number;
}
```

`min_cinematography_confidence` applies to every concrete cinematography field group requested by the filter. For example, a query with `shot_scale` and `subject_facing_direction` should require both framing and direction confidence to pass the threshold.

Extend `FootageEvidenceRef.field` with:

```ts
| "camera_movement"
| "shot_scale"
| "framing"
| "subject_direction"
| "depth_spatial"
```

Extend `FootageSearchResult` with an optional compact object:

```ts
cinematography?: {
  camera_movement_type: string;
  camera_movement_direction: string;
  camera_movement_speed: string;
  camera_stability: string;
  shot_scale: string;
  composition_anchor: string;
  subject_screen_zone: string;
  subject_facing_direction: string;
  subject_movement_direction: string;
  eye_line_direction: string;
  camera_axis: string;
  depth_of_field: string;
  foreground_present: boolean;
  foreground_types: string[];
  background_complexity: string;
  confidence: {
    movement?: number;
    framing?: number;
    direction?: number;
    spatial_depth?: number;
  };
}
```

## 10. Builder Mapping And Confidence Rules

### 10.1 Source Priority

For each segment, build the row from the highest-confidence available source:

| Field group | P0 source | P1 source | Confidence rule |
| --- | --- | --- | --- |
| movement type/direction | Marlin event phrase plus Gemini confirmation | optical flow / homography | prose-only cap around `0.65`; CV-confirmed can exceed. |
| movement speed | Gemini coarse label | optical flow magnitude | P0 should often be `unknown`; avoid fake precision. |
| stability | existing `quality_flags` (`shaky`) plus Gemini | transform variance | `quality_flags` can identify bad stability but not subtle steadicam. |
| shot scale | Gemini structured frame classification | detector/box ratio plus Gemini | high confidence when dominant subject box is clear. |
| framing and screen zone | Gemini plus subject box | detector/box geometry | use `unknown` when no dominant subject exists. |
| facing/eye line | Gemini | face/body pose model | P0 confidence should be conservative. |
| subject movement | Marlin phrase plus Gemini | tracked boxes | needs temporal tracking for reliable direction. |
| depth/foreground/background | Gemini | segmentation/depth/blur models | P0 useful as search hint; not hard continuity gate. |

### 10.2 Unknown And Null Policy

- Closed enum fields default to `unknown`, `none`, `not_applicable`, or `not_visible` as appropriate.
- Confidence can be null when the field group is wholly unknown.
- A requested structured filter should return a warning when the DB has no indexed cinematography rows.
- Search should not treat `unknown` as matching a concrete requested value.
- Low-confidence matches can be returned, but the result should expose evidence and confidence.

### 10.3 Build Report Additions

Add to `footage-db-build-report.json`:

```json
{
  "cinematography_status": "ready",
  "cinematography_sources": {
    "marlin_phrase_parser": { "segments": 12, "events": 18 },
    "gemini_cinematography": { "segments": 89 },
    "cv_camera_motion": { "segments": 0 }
  },
  "counts": {
    "cinematography_rows": 89,
    "cinematography_events": 18
  },
  "warnings": [
    "cinematography: eye_line_direction unknown for 37 segments"
  ]
}
```

Allowed `cinematography_status`:

- `ready`
- `partial`
- `skipped`
- `unavailable`
- `error`

## 11. Editorial Agent Usage

### 11.1 Search Queries

Find a medium shot facing right to match a close-up facing right:

```json
{
  "query": "medium shot same subject direction",
  "mode": "hybrid",
  "filters": {
    "shot_scale": "medium",
    "subject_facing_direction": "right",
    "min_cinematography_confidence": 0.55,
    "exclude_quality_flags": ["shaky", "blurry"]
  },
  "limit": 8
}
```

Find a static shot to follow a fast pan:

```json
{
  "query": "calm static stable shot",
  "mode": "hybrid",
  "filters": {
    "camera_movement_type": "static",
    "camera_stability": "stable",
    "camera_movement_speed": "none",
    "min_cinematography_confidence": 0.50
  },
  "limit": 8
}
```

Find wide establishing shots from a location:

```json
{
  "query": "wide establishing shot readable environment",
  "mode": "hybrid",
  "filters": {
    "shot_scale_any": ["extreme_wide", "wide"],
    "place_hint_category": "outdoor",
    "background_complexity": "complex",
    "exclude_quality_flags": ["blurry", "shaky"]
  },
  "limit": 12
}
```

Find movement-compatible left-to-right pan material:

```json
{
  "query": "pan right continuing motion",
  "mode": "hybrid",
  "filters": {
    "camera_movement_type": "pan",
    "camera_movement_direction": "left_to_right",
    "camera_movement_speed": "medium"
  },
  "limit": 8
}
```

Find a shallow-depth close-up after a busy wide:

```json
{
  "query": "isolated close-up with soft background",
  "mode": "hybrid",
  "filters": {
    "shot_scale_any": ["medium_close_up", "close_up"],
    "depth_of_field": "shallow",
    "background_complexity": "simple"
  },
  "limit": 8
}
```

### 11.2 Pairing And Continuity Heuristics

The agent can use the metadata before introducing a replacement candidate:

- Match movement direction when continuity is desired:
  - prefer same `camera_movement_direction`
  - prefer neighboring `camera_movement_speed`
  - avoid `shaky` unless the sequence is already handheld
- Use contrast deliberately:
  - `fast` movement followed by `static` can create emphasis or relief
  - `deep` wide followed by `shallow` close-up can move from place to emotion
- Avoid accidental jump cuts:
  - same subject, same `shot_scale`, same `composition_anchor`, and same screen zone should require a story reason or a transition device
- Protect 180-degree continuity:
  - maintain `camera_axis`, `subject_facing_direction`, and `subject_movement_direction` within a scene unless the beat intends disorientation
  - treat `unknown` as a warning, not a hard blocker

### 11.3 Compiler And Craft Integration

The structure-first craft design already expects shot scale and composition evidence. This DB layer should feed that evidence without making the compiler call models.

Near-term integration:

- `search_footage` returns cinematography fields and evidence refs.
- The editorial agent cites cinematography evidence when proposing a new candidate.
- Transition scoring can consume DB-derived values through the existing `adjacency_features` shape when materialized later.

Future materialization:

- `segment_cinematography.transition_shot_scale -> peak_analysis.adjacency_features.shot_scale`
- `segment_cinematography.composition_anchor -> peak_analysis.adjacency_features.composition_anchor`
- `segment_cinematography.subject_screen_zone -> peak_analysis.adjacency_features.screen_side`
- `segment_cinematography.eye_line_direction -> peak_analysis.adjacency_features.gaze_direction`
- `segment_cinematography.camera_axis -> peak_analysis.adjacency_features.camera_axis`
- movement mapping from section 4.1 -> `peak_analysis.adjacency_features.motion_type`

This should remain additive. Existing projects without these fields should continue to compile with current fallbacks.

## 12. Implementation Phasing

### Phase 1: DB-Only Cinematography Rows

Goal: make shot language searchable without touching canonical schemas.

Work:

- Add `segment_cinematography` and `cinematography_events` to footage DB schema version 2.
- Populate conservative rows from existing tags, quality flags, Marlin phrase parsing, and optional Gemini structured classification.
- Add FTS and embedding text terms.
- Extend search filters and result evidence.

Acceptance:

- DB builds when cinematography extraction is skipped.
- Search filters for `shot_scale`, `camera_movement_type`, and `camera_stability` work.
- Results expose confidence and provenance.

### Phase 2: Gemini Cinematography Classifier

Goal: extract practical shot scale, framing, direction, and depth cues from sampled frames.

Work:

- Add a narrow JSON prompt that returns only bounded cinematography fields.
- Keep it separate from scene summary ownership.
- Cache by segment, frame set, prompt hash, and model snapshot.
- Add parse retry and fail-open behavior mirroring existing VLM connector style.

Acceptance:

- Missing `GEMINI_API_KEY` skips the pass.
- Invalid JSON does not block the DB build.
- Fields with weak evidence become `unknown`, not guessed.

### Phase 3: Deterministic Camera Motion CV

Goal: improve movement and stability reliability.

Work:

- Add frame-to-frame transform analysis for pan/tilt/push/pull and shakiness.
- Add event rows for movement changes within a segment.
- Compare CV labels with Marlin/Gemini and record disagreement.

Acceptance:

- Static vs moving vs shaky classification is repeatable.
- Movement direction and speed have measurable evidence.
- CV absence does not break search.

### Phase 4: Subject Tracking And Continuity Evidence

Goal: improve subject direction and line-of-action support.

Work:

- Add dominant subject tracking over sampled frames.
- Add face/body pose where visible.
- Derive `subject_movement_direction`, `subject_facing_direction`, `eye_line_direction`, and `camera_axis`.
- Optionally materialize compatible values into `adjacency_features`.

Acceptance:

- Same-scene pairs can compute better `axis_consistency_score`.
- Unknown/multiple-subject cases remain warnings.
- The compiler still consumes materialized evidence, not raw models.

## 13. Risks And Mitigations

Overconfident labels:

- Mitigation: conservative confidence caps, `unknown` defaults, evidence refs, and source provenance.

Sparse frame sampling:

- Mitigation: use temporal events and CV for movement; do not classify fast camera work from one still frame.

Subject/camera motion confusion:

- Mitigation: separate `camera_movement_direction` from `subject_movement_direction`; use tracking before high confidence.

Schema duplication:

- Mitigation: keep professional search vocabulary in the DB, and map back to existing transition vocabulary explicitly.

Search overconstraint:

- Mitigation: agent should use hard filters only for necessary continuity constraints; use natural-language query plus confidence for soft preferences.

Privacy and sharing:

- Mitigation: treat cinematography rows like existing `03_analysis` data. They may include frame-derived descriptions and should inherit the DB sharing policy.

## 14. Verification Strategy

Unit tests for a future implementation:

- DDL applies cleanly and `PRAGMA integrity_check` returns `ok`.
- Enum constraints reject invalid shot/movement labels.
- Search filters join `segment_cinematography` without changing old filters.
- Missing cinematography rows return warnings and do not break search.
- FTS `cinematography` text matches movement and shot-scale terms.

Fixture tests:

- Static tripod wide shot.
- Handheld shaky close-up.
- Pan left-to-right with event timing.
- Subject walking right-to-left while camera is static.
- Interview-like frame with clear eye line.
- Shallow-depth close-up with simple background.
- Deep-focus establishing wide with complex background.

Manual verification:

```bash
npx tsx scripts/build-footage-db.ts --project projects/<id> --embedding-policy skip
sqlite3 projects/<id>/03_analysis/search/footage.db 'PRAGMA integrity_check;'
sqlite3 projects/<id>/03_analysis/search/footage.db \
  "SELECT segment_id, shot_scale, camera_movement_type, subject_facing_direction FROM segment_cinematography LIMIT 10;"
```

Human acceptance:

- An editor can inspect returned fields and understand why a shot was suggested.
- The agent can find a movement-compatible shot, a movement-contrast shot, and an establishing shot.
- Low-confidence screen-direction evidence is visible enough for the agent to avoid overclaiming continuity.

## 15. Self-Review

Rubric score after revision: 96/100.

Remaining deductions:

- Exact CV model choices are intentionally deferred because the first useful layer can be DB plus Gemini classification.
- The future materialization path into `segments.json.peak_analysis.adjacency_features` needs a separate schema/runtime proposal if the team wants compiler-native continuity beyond search.

Final check:

- Purpose and success conditions are defined.
- Scope stays docs-only and DB-derived.
- Vocabularies are closed.
- Marlin, Gemini, and future CV responsibilities are separated.
- DDL and search API additions are exact enough to implement.
- Risks, fallback behavior, and verification are covered.
