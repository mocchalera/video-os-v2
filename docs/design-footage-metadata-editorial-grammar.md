# Design: Footage Metadata for Editorial Grammar and Continuity

Scope: design only. This proposes additive metadata for the derived footage
database described in `docs/design-footage-database-unified.md`. It does not
change canonical artifacts such as `segments.json`, `selects_candidates.yaml`,
`edit_blueprint.yaml`, or `timeline.json`.

Perspective: film-editor sequencing, continuity, and cut grammar. The goal is
not to make the database "creative." The goal is to expose enough observable
grammar that the editorial agent and compiler can make better sequencing
decisions without inventing visual facts.

## 1. Position

The current footage DB is good at finding material by text, quality, tags,
transcript, peaks, and Marlin events. Professional editing also needs pairwise
metadata:

- Can these two shots cut together without confusing screen geography?
- Does this close-up have a matching reverse?
- Can this action direction continue through the next shot?
- Is this a match cut, dissolve, J-cut, L-cut, or hard cut candidate?
- How long does this shot need to read?

The proposed layer adds an editorial-grammar index over existing segments. It
should be generated under `03_analysis/search/footage.db`, versioned separately
from planning artifacts, and rebuilt from source analysis plus optional user
annotation.

## 2. Design Principles

- Keep the DB derived and rebuildable. Do not widen canonical analysis or
  planning schemas for this design.
- Store confidence and evidence basis for every spatial claim.
- Separate per-segment facts from pairwise compatibility. A shot can be "looking
  left"; a pair can be a "valid shot-reverse-shot."
- Treat identity, same-scene grouping, narrative day, and imaginary-line
  orientation as uncertain unless confirmed by evidence or user annotation.
- Prefer warning-level continuity checks in rough cut, targeted pair repair in
  fine cut, and exact frame/audio checks in polish.
- Let Marlin provide temporal event text, but do not treat Marlin text as
  frame-accurate geometry.

## 3. Workflow Fit

### Rough cut

Use coarse metadata:

- same scene or different scene grouping
- wide/medium/close scale
- motion energy and emotional intensity
- rough screen direction
- transition affordance scores

The rough cut should avoid obvious spatial breaks, repeated grammar, and
unreadable pace. Unknown continuity should create warnings, not blockers.

### Fine cut

Use pair metadata:

- axis consistency and line-crossing risk
- shot-reverse-shot compatibility
- action direction continuity
- match-cut, dissolve, hard-cut, J-cut, and L-cut compatibility
- minimum readable duration and preferred hold duration

The fine pass can search the full pool only for targeted repairs: weak adjacent
pairs, missing reverse shots, or overcompressed moments.

### Polish

Use frame/audio-level precision:

- exact cut point near action or gaze shift
- eyeline height tolerance
- color and shape match tolerance
- audio handle viability for J-cuts and L-cuts
- intentional line-crossing annotations

Polish is where frame-level computer vision and human confirmation matter most.

## 4. 180-Degree Rule and Imaginary Line

### Metadata needed

The 180-degree rule cannot be enforced from a single segment alone. It needs a
scene-space model and per-subject/action orientation inside that scene:

| Metadata | Meaning | Practical source |
| --- | --- | --- |
| `scene_space_id` | A group of shots that appear to share spatial continuity. | Existing continuity graph, source order, Marlin scene text, location hints, user annotation. |
| `camera_angle_id` | A distinct angle within a `scene_space_id`. | Frame similarity, subject placement, camera position clues, user annotation. |
| `axis_id` | The active imaginary line for a subject pair, action path, or spatial relation. | User annotation first; inferred only when subject/action evidence is strong. |
| `axis_basis` | Why the line exists: `two_subject_line`, `action_vector`, `entrance_exit`, `camera_to_subject`, `user_confirmed`. | Pair evidence and context interview. |
| `subject_screen_side` | Where a subject lands in the frame: `left`, `center`, `right`, `mixed`. | Face/person box center or existing adjacency features. |
| `subject_facing_direction` | Which way the subject faces on screen: `left`, `right`, `camera`, `away`, `unknown`. | Face yaw/body pose; Marlin text only as weak evidence. |
| `gaze_direction` | Eyeline direction independent of body facing. | Face/eye landmarks; user annotation for low-quality footage. |
| `action_direction` | Dominant movement: `ltr`, `rtl`, `toward_camera`, `away_camera`, `static`, `mixed`, `unknown`. | Optical flow, person track delta, Marlin event verbs. |
| `camera_axis` | Screen axis class already represented in compiler pair evidence: `ltr`, `rtl`, `neutral`, `unknown`. | Derived from action and subject direction. |
| `axis_consistency_score` | Pair score for whether the cut preserves screen direction. | Pairwise derived metadata. |
| `axis_break_readiness_score` | Pair score for whether a line crossing is likely acceptable. | Cutaway/reset/disorientation evidence and user intent. |

### Subject screen position

Screen position should be stored per detected subject, not just per segment.
The same segment can contain two people on opposite sides of the frame.

Represent positions as both a normalized numeric box and a coarse label:

- `bbox_center_x`, `bbox_center_y`, `bbox_width`, `bbox_height`
- `screen_side`: `left`, `center`, `right`, `mixed`, `unknown`
- `composition_anchor`: `left`, `center_left`, `center`, `center_right`, `right`
- `subject_prominence`: copied or derived from visual quality when available

For editing, the coarse labels are queryable. The numeric values support
threshold tuning later.

### Subject facing direction

Facing direction should be separate from gaze:

- `facing_direction`: body/head orientation on screen
- `gaze_direction`: eye direction when visible
- `pose_direction`: body orientation if the face is not visible

In documentary or B-roll footage, body orientation often matters more than true
eye gaze. Store all three with confidence so the agent can prefer high-quality
evidence.

### Action direction

Action direction should be based on tracked subject/object motion when possible:

- `action_direction`: `ltr`, `rtl`, `toward_camera`, `away_camera`, `static`,
  `mixed`, `unknown`
- `motion_vector_x`: negative for screen-left movement, positive for
  screen-right movement
- `motion_vector_y`: vertical movement, useful for gestures and stairs
- `action_start_us`, `action_end_us`: event window when known
- `dominant_motion_is_camera`: true when motion is likely pan/tilt/handheld
  rather than subject action

`runtime/analysis/camera-motion.ts` already detects Marlin descriptions that
look like camera setup motion. That logic should feed a penalty so camera shake
is not mistaken for action direction.

### Same scene, different angle vs different scene

A usable editor-facing representation needs two layers:

- `scene_space_id`: shots that can be treated as the same scene or spatial
  environment.
- `camera_angle_id`: a view inside the same scene space.

Examples:

- Same room, same people, alternate close-up: same `scene_space_id`, different
  `camera_angle_id`.
- Same building exterior later in the day: likely same location, but not
  necessarily same `scene_space_id` unless continuity evidence says so.
- Same subject in different town: same subject entity, different
  `scene_space_id`.
- Montage across locations: different `scene_space_id` values; line continuity
  generally should not be enforced.

Each membership should carry:

- `membership_basis`: `user_confirmed`, `continuity_graph`, `source_session`,
  `marlin_scene`, `visual_similarity`, `unknown`
- `same_scene_confidence`
- `different_scene_confidence`
- `evidence_json`

### When it is OK to cross the line

Line crossing should not always be a hard error. It can be acceptable when:

- A neutral shot resets geography: centered subject, front-on view,
  establishing wide, insert, or cutaway.
- The camera visibly moves across the line in the outgoing or incoming shot.
- The cut marks a scene break, time jump, memory shift, or change of location.
- The edit intentionally disorients: conflict, surprise, subjective confusion,
  impact, dream, or montage rupture.
- A subject turns around or the action direction changes on-screen before the
  cut.
- The previous and next shots are not part of the same spatial scene.
- The user has annotated the break as intentional.

Represent this as pair metadata, not as a global exemption:

- `axis_break_risk`: `none`, `low`, `medium`, `high`
- `axis_break_reason`: `crossed_line`, `action_reversal`, `gaze_mismatch`,
  `scene_unknown`
- `axis_break_allowed`: 0 or 1
- `axis_break_allow_basis`: `neutral_reset`, `camera_crosses_line`,
  `scene_break`, `intentional_disorientation`, `user_annotation`, `unknown`
- `axis_break_note`

The rough cut should warn on high-risk unallowed breaks. Fine cut can search for
replacement angles or insert neutral reset shots.

## 5. Shot-Reverse-Shot and Eyeline Match

### Metadata needed

Shot-reverse-shot requires more than "dialogue." It needs subject identity or
role, screen side, gaze/facing direction, eyeline height, and scene grouping.

Per subject:

- `subject_ref`: a local stable ref such as `SUBJ_local_001` or a continuity
  graph entity id when available.
- `subject_label`: optional human-readable label; nullable by default.
- `dialogue_role`: `speaker`, `listener`, `reaction`, `unknown`
- `screen_side`
- `facing_direction`
- `gaze_direction`
- `eyeline_y`: normalized frame y-coordinate of eye or face center
- `shot_scale`: `extreme_close`, `close`, `medium_close`, `medium`,
  `medium_wide`, `wide`, `extreme_wide`, `unknown`
- `has_clean_reaction`: derived from silence/reaction/Marlin event evidence
- `confidence`

Per pair:

- `pair_type = 'shot_reverse'`
- `same_scene_space = 1`
- `opposing_gaze_score`
- `eyeline_height_delta`
- `shot_scale_match_score`
- `screen_balance_score`
- `audio_dialogue_fit_score`
- `can_pair = 1`
- `risk_json`

### Direction rule

For a basic two-person reverse:

- Subject A looking screen-right should pair with Subject B looking screen-left.
- Subject A on frame-left looking right should usually pair with Subject B on
  frame-right looking left.
- Eyeline height should be near enough that the viewer feels the subjects occupy
  the same vertical space.
- Shot scale should be matched or intentionally varied: close-up to close-up for
  smooth dialogue, wide to close for emphasis.

The pair score should not require named identity for every project. It can work
with roles:

- `speaker_a_ref` and `speaker_b_ref` if diarization or annotation exists.
- `subject_ref` clusters if visual identity is available.
- `dialogue_side = 'left_listener' | 'right_listener'` when only geometry is
  known.

### Eyeline height matching

Store normalized values:

- `eyeline_y`: 0 at top, 1 at bottom
- `eyeline_confidence`
- `eyeline_basis`: `face_landmark`, `face_box`, `pose_landmark`,
  `manual_annotation`, `unknown`

Pair scoring:

- `eyeline_height_delta <= 0.08`: strong match
- `0.08 < delta <= 0.15`: acceptable if shot scale differs
- `delta > 0.15`: warning unless intentionally stylized

These thresholds should be tunable. For handheld documentary footage, strict
eyeline enforcement can create false alarms.

### Tagging clips as "can pair with"

Use pair rows rather than writing arrays into segment rows:

```sql
segment_pair_compatibility(
  left_segment_id,
  right_segment_id,
  pair_type = 'shot_reverse',
  score,
  recommended_transition_type = 'cut',
  evidence_json,
  risk_json
)
```

This allows queries such as:

- Find a reverse for this close-up.
- Find a reaction shot that matches this eyeline but is calmer.
- Find a listener shot from the same scene that can take an L-cut.

## 6. Match Cut Detection

Match cuts should be treated as high-confidence pair recommendations. A bad
match cut is worse than a plain cut because it calls attention to itself.

### Composition similarity

Per segment, store a visual signature from the representative frame and, later,
from candidate cut frames:

- `shot_scale`
- `composition_anchor`
- `subject_center_x`, `subject_center_y`
- `subject_area_ratio`
- `horizon_y` when detectable
- `dominant_shape_tags_json`
- `dominant_colors_json`
- `visual_hash`
- optional local visual embedding blob if a local model is approved

Pair features:

- `composition_match_score`
- `shot_scale_continuity_score`
- `subject_position_delta`
- `horizon_delta`

Practical MVP: use existing visual quality composition tags, subject prominence,
shot scale from adjacency features where available, and simple OpenCV frame
features. Ideal later: local visual embeddings and object/shape segmentation.

### Motion matching

Motion match cut metadata should distinguish subject motion from camera motion:

- `outgoing_motion_vector_x`, `outgoing_motion_vector_y`
- `incoming_motion_vector_x`, `incoming_motion_vector_y`
- `motion_phase`: `windup`, `impact`, `follow_through`, `settled`, `unknown`
- `pose_keypoint_signature_json` when MediaPipe is available
- `motion_match_score`

Examples:

- hand reaches down in clip A, hand reaches down in clip B
- person turns left in clip A, object rotates left in clip B
- bicycle moves left-to-right, train moves left-to-right

Practical MVP: Marlin event descriptions and optical-flow direction. Fine cut:
sample frames around candidate cut points and compare optical flow/pose phase.

### Color and tone matching

Store both coarse labels and numeric features:

- `color_temperature`: `cool`, `neutral`, `warm`, `mixed`, `unknown`
- `warmth_score`
- `brightness_score`
- `contrast_score`
- `saturation_score`
- `dominant_colors_json`
- `tone_match_score` at pair level
- `tone_contrast_score` for intentional contrast

Warm-to-warm and low-key-to-low-key are dissolve/match candidates. Warm-to-cool
can be an intentional contrast if story or beat purpose supports it.

### Shape matching

Shape matching can start coarse:

- `shape_tags_json`: `round`, `vertical_lines`, `horizontal_lines`, `diagonal`,
  `face_oval`, `doorway`, `window`, `plate`, `wheel`, `sign`, `hands`
- `object_tags_json`
- `shape_match_score`

Practical MVP: Marlin/Gemini text and OpenCV contour summaries. Later: local
detector/segmenter output. A shape match should remain a suggestion unless a
sampled frame confirms it.

## 7. Temporal Continuity

### Same filming session

The unified DB already stores nullable `shooting_date`, `shooting_time`, source
order, and asset duration. The current policy is correct: do not infer shooting
date/time/camera from filenames unless a deterministic parser or sidecar is
approved.

Add a derived session layer:

- `session_id`
- `session_basis`: `manifest_timecode`, `file_metadata`, `source_order_window`,
  `user_annotation`, `unknown`
- `session_confidence`
- `capture_order`
- `capture_gap_us` or nullable gap estimate

Use this for chronology and grouping, not as a hard truth.

### Same subject across multiple clips

The repo already has a continuity graph schema with entity types for subject,
location, prop, motif, and action. The footage DB should index that graph rather
than invent a competing identity model.

Per segment, store:

- `entity_id` when continuity graph provides one
- `subject_ref` for local detected subjects without confirmed identity
- `subject_label` only when user-confirmed or already present in context
- `identity_confidence`
- `identity_basis`: `continuity_graph`, `face_cluster`, `person_reid`,
  `transcript_speaker`, `user_annotation`, `unknown`

Privacy note: face/person re-identification should be project-local, opt-in, and
redactable. Unknown people can be useful for screen grammar without naming them.

### Wardrobe and lighting consistency

Wardrobe and lighting support "same narrative day" decisions:

- `wardrobe_signature`: compact hash or label of dominant clothing colors and
  style
- `wardrobe_label`: optional human-readable label, nullable
- `lighting_signature`: color temperature, intensity, contrast, source direction
- `narrative_day_id`: user-confirmed or high-confidence inferred group
- `narrative_day_basis`

The agent can use this to avoid cutting from a person in a red jacket to the
same supposed moment in a blue jacket unless a time jump is intended.

### Time-of-day cues

Store cues separately from facts:

- `time_of_day_label`: `morning`, `midday`, `afternoon`, `golden_hour`,
  `evening`, `night`, `indoor_unknown`, `unknown`
- `time_of_day_basis`: `source_metadata`, `user_annotation`, `sun_angle`,
  `color_temperature`, `marlin_text`, `unknown`
- `time_of_day_confidence`

This allows "morning-feeling" searches without fabricating capture time.

## 8. Energy and Rhythm Metadata

### Motion energy

Per segment:

- `motion_energy`: 0 to 1, from optical flow, subject track velocity, and
  Marlin action density
- `camera_motion_energy`: 0 to 1, separate from subject motion
- `motion_type`: existing vocabulary from transition evidence (`static`, `pan`,
  `tilt`, `push_in`, `pull_out`, `tracking`, `handheld`, `fast_action`,
  `reveal`, `unknown`)
- `motion_quality`: copied from existing visual quality where available

This supports searches such as "same energy but different angle" and gates hard
cuts versus dissolves.

### Audio energy

Per segment:

- `audio_loudness_lufs`
- `audio_peak_dbfs`
- `audio_rms`
- `speech_density`
- `music_density`
- `silence_head_us`
- `silence_tail_us`
- `natural_sound_interest`: 0 to 1
- `incoming_audio_interest`: 0 to 1
- `outgoing_audio_hold_interest`: 0 to 1

The current DB has waveform paths and transcripts, and peak analysis has
`audio_support_score`. The proposed layer adds numeric audio affordances for
transition decisions.

### Emotional intensity

Per segment:

- `emotional_intensity`: 0 to 1
- `emotional_phase`: `calm`, `building`, `peak`, `resolving`, `neutral`,
  `unknown`
- `emotional_basis`: visual expression score, transcript sentiment, Marlin event
  text, peak analysis, user annotation

This maps to the craft vocabulary: calm breathing room, build to peak,
afterglow, and release.

### Cut pace compatibility

Not every clip can be cut to any duration. Store:

- `min_read_duration_us`: shortest duration before the shot becomes unreadable
- `preferred_duration_us`: duration that lets the moment land
- `max_compress_duration_us`: hard compression floor for montage use
- `can_work_as_flash`: 0 or 1
- `can_work_as_texture`: 0 or 1
- `needs_context_preroll`: 0 or 1
- `needs_post_action_hold`: 0 or 1

Examples:

- A centered close-up reaction may read in 2 seconds.
- A wide establishing shot may need 6 to 8 seconds.
- A hand action may need preroll before contact plus post-action hold.
- A sign insert may need enough duration for text readability.

This gives the rough cut better duration choices before review metrics complain
about rhythm.

## 9. Transition Compatibility

### Dissolve candidates

Dissolves usually work when:

- composition is similar enough that the blend is legible
- content changes enough to signal passage or association
- motion energy is low to medium
- shot scale is compatible
- color/tone does not create ugly flicker unless contrast is intentional
- handles are available on both sides

Store:

- `dissolve_in_score`
- `dissolve_out_score`
- pair `dissolve_compatibility_score`
- `dissolve_reason`: `time_passage`, `memory`, `topic_bridge`,
  `texture_bridge`, `visual_association`

### Hard-cut candidates

Hard cuts work when:

- action peak or semantic turn is clear
- energy contrast is intentional
- rhythm wants a beat/downbeat snap
- screen direction is consistent or intentionally broken
- the outgoing and incoming frames are visually readable

Store:

- `hard_cut_in_score`
- `hard_cut_out_score`
- `energy_delta_score`
- `beat_snap_potential`
- `clean_cut_boundary_score`

### J-cut and L-cut candidates

The timeline schema and transition type vocabulary include `j_cut` and `l_cut`,
but the craft design treats full audio-overlap execution as deferred until the
IR supports it cleanly. The metadata can still be indexed now:

- `j_cut_in_score`: incoming audio can lead before picture
- `l_cut_out_score`: outgoing audio should carry under next picture
- `audio_handle_head_us`
- `audio_handle_tail_us`
- `incoming_audio_interest`
- `outgoing_audio_hold_interest`
- `speech_boundary_clean_in_score`
- `speech_boundary_clean_out_score`

The agent may use these as search signals, but compile should degrade or warn if
the current execution path cannot preserve the intended audio overlap.

### Dip-to-black candidates

Dip-to-black candidates usually have:

- natural endpoint
- emotional resolution
- silence tail or clean audio decay
- low outgoing motion
- scene/chapter boundary
- no urgent action continuity

Store:

- `dip_to_black_out_score`
- `endpoint_score`
- `afterglow_score`
- `silence_tail_us`
- `chapter_boundary_likelihood`

## 10. Extraction Plan

### What Marlin already provides

`runtime/connectors/marlin-types.ts` models asset-level Marlin output:

- scene text
- caption text
- temporal events with start/end, description, confidence, source pass, and
  chunk offsets
- find results for requested event spans

Useful derived signals:

- event windows for action/reaction timing
- action/reaction vocabulary for trim and transition intent
- rough scene descriptions for same-scene hypotheses
- possible direction words if Marlin mentions left/right, but this should be
  weak evidence only

Limitations:

- no frame coordinates
- no face boxes, gaze, or eyeline height
- no stable subject identity
- no reliable color histogram, shape signature, or optical flow
- temporal descriptions may be good for "what happens" but not sufficient for
  imaginary-line enforcement

### What existing repo metadata can infer

Existing surfaces can already seed the layer:

- `segments` times, source asset, representative frame, filmstrip, waveform
- `visual_quality` composition, subject prominence, expression, motion quality,
  labels
- `visual_appraisal` place/text/aesthetic hints
- `peak_analysis` motion/audio support and action/emotional/visual peaks
- `marlin_events` by segment overlap
- `continuity_graph.json` entities, same-subject/location/action edges, visual
  match/contrast, and axis-break risks when present
- compiler transition evidence fields: shot scale, composition anchor, screen
  side, gaze direction, camera axis, axis consistency, energy delta

### What needs frame-level analysis

Practical local analysis:

- OpenCV frame sampling for color histograms, brightness, contrast, contour
  shapes, and simple visual hashes
- Optical flow for motion energy and action direction
- Shot-boundary/frame sampling around segment in/out for transition handles
- FFmpeg audio analysis for RMS, LUFS, peaks, silence head/tail

Optional stronger analysis:

- MediaPipe face/body/pose for screen side, eyeline height, gaze/facing
  direction, and gesture phase
- local visual embeddings for match-cut similarity
- local face/person clustering for subject continuity, behind an explicit
  project-local privacy switch

### What the editorial agent can infer

The editorial agent can combine existing facts into judgments:

- "This likely needs a longer hold because it is wide, low-motion, and the beat
  is a release."
- "This line crossing is risky because both shots are in the same scene and
  action direction flips without a reset."
- "This is a possible match cut, but confidence is low because shape evidence is
  only textual."
- "This J-cut is attractive, but execution is deferred; record uncertainty."

It must not invent:

- subject identity
- scene grouping
- exact gaze
- capture time
- wardrobe continuity
- intentional line crossing

If evidence is missing, the output should be an uncertainty, warning, or user
annotation request.

### What needs user annotation

Context interview additions should allow:

- named subject aliases and privacy/redaction rules
- "these clips are the same scene"
- "these clips are different scenes despite visual similarity"
- subject A talks to subject B
- axis/line definition for a dialogue or action scene
- "crossing the line is intentional here"
- narrative day grouping
- wardrobe continuity overrides
- preferred transition language for a project
- clips that are off-limits for identity matching

Annotations should be stored as project-local source inputs and indexed into the
derived DB with provenance. They should not be hidden in prompt text.

## 11. Database Schema Additions

This is an additive schema version over the current footage DB. The existing DB
can keep `artifact_version = 'footage-db-v1'`, but `footage_db_meta.schema_version`
should advance to `2` when these tables are present. If implementation prefers
smaller rollout, store `editorial_grammar_schema_version = '1'` in
`footage_db_meta` and keep the base schema version unchanged until all tables
land.

### Scene and axis grouping

```sql
CREATE TABLE continuity_scene_groups (
  scene_space_id TEXT PRIMARY KEY,
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('hypothesis', 'confirmed', 'rejected', 'unknown')),
  location_entity_id TEXT,
  session_id TEXT,
  grouping_basis TEXT NOT NULL CHECK (
    grouping_basis IN ('user_annotation', 'continuity_graph', 'source_session', 'marlin_scene', 'visual_similarity', 'unknown')
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE continuity_axes (
  axis_id TEXT PRIMARY KEY,
  scene_space_id TEXT NOT NULL REFERENCES continuity_scene_groups(scene_space_id) ON DELETE CASCADE,
  axis_basis TEXT NOT NULL CHECK (
    axis_basis IN ('two_subject_line', 'action_vector', 'entrance_exit', 'camera_to_subject', 'user_confirmed', 'unknown')
  ),
  subject_a_ref TEXT,
  subject_b_ref TEXT,
  action_ref TEXT,
  screen_direction TEXT CHECK (
    screen_direction IS NULL OR screen_direction IN ('ltr', 'rtl', 'toward_camera', 'away_camera', 'neutral', 'unknown')
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE segment_scene_membership (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  scene_space_id TEXT NOT NULL REFERENCES continuity_scene_groups(scene_space_id) ON DELETE CASCADE,
  camera_angle_id TEXT,
  angle_role TEXT CHECK (
    angle_role IS NULL OR angle_role IN ('establishing', 'wide', 'over_shoulder', 'single', 'reverse', 'insert', 'cutaway', 'pov', 'unknown')
  ),
  same_scene_confidence REAL NOT NULL CHECK (same_scene_confidence >= 0 AND same_scene_confidence <= 1),
  different_scene_confidence REAL CHECK (different_scene_confidence IS NULL OR (different_scene_confidence >= 0 AND different_scene_confidence <= 1)),
  membership_basis TEXT NOT NULL CHECK (
    membership_basis IN ('user_annotation', 'continuity_graph', 'source_session', 'marlin_scene', 'visual_similarity', 'unknown')
  ),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (segment_id, scene_space_id)
);

CREATE INDEX idx_segment_scene_scene ON segment_scene_membership(scene_space_id, camera_angle_id);
```

### Subject presence and eyeline

```sql
CREATE TABLE segment_subject_presence (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  subject_ref TEXT NOT NULL,
  entity_id TEXT,
  subject_label TEXT,
  identity_basis TEXT NOT NULL CHECK (
    identity_basis IN ('continuity_graph', 'face_cluster', 'person_reid', 'transcript_speaker', 'user_annotation', 'unknown')
  ),
  dialogue_role TEXT CHECK (
    dialogue_role IS NULL OR dialogue_role IN ('speaker', 'listener', 'reaction', 'unknown')
  ),
  bbox_center_x REAL CHECK (bbox_center_x IS NULL OR (bbox_center_x >= 0 AND bbox_center_x <= 1)),
  bbox_center_y REAL CHECK (bbox_center_y IS NULL OR (bbox_center_y >= 0 AND bbox_center_y <= 1)),
  bbox_width REAL CHECK (bbox_width IS NULL OR (bbox_width >= 0 AND bbox_width <= 1)),
  bbox_height REAL CHECK (bbox_height IS NULL OR (bbox_height >= 0 AND bbox_height <= 1)),
  screen_side TEXT NOT NULL CHECK (screen_side IN ('left', 'center', 'right', 'mixed', 'unknown')),
  shot_scale TEXT NOT NULL CHECK (
    shot_scale IN ('extreme_close', 'close', 'medium_close', 'medium', 'medium_wide', 'wide', 'extreme_wide', 'unknown')
  ),
  facing_direction TEXT NOT NULL CHECK (facing_direction IN ('left', 'right', 'camera', 'away', 'unknown')),
  gaze_direction TEXT NOT NULL CHECK (gaze_direction IN ('left', 'right', 'camera', 'away', 'unknown')),
  pose_direction TEXT NOT NULL CHECK (pose_direction IN ('left', 'right', 'camera', 'away', 'unknown')),
  eyeline_y REAL CHECK (eyeline_y IS NULL OR (eyeline_y >= 0 AND eyeline_y <= 1)),
  eyeline_basis TEXT CHECK (
    eyeline_basis IS NULL OR eyeline_basis IN ('face_landmark', 'face_box', 'pose_landmark', 'manual_annotation', 'unknown')
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (segment_id, subject_ref)
);

CREATE INDEX idx_subject_presence_subject ON segment_subject_presence(subject_ref, segment_id);
CREATE INDEX idx_subject_presence_gaze ON segment_subject_presence(gaze_direction, screen_side, shot_scale);
```

### Action flow and visual signature

```sql
CREATE TABLE segment_action_flow (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  action_direction TEXT NOT NULL CHECK (
    action_direction IN ('ltr', 'rtl', 'toward_camera', 'away_camera', 'static', 'mixed', 'unknown')
  ),
  motion_vector_x REAL,
  motion_vector_y REAL,
  motion_energy REAL CHECK (motion_energy IS NULL OR (motion_energy >= 0 AND motion_energy <= 1)),
  camera_motion_energy REAL CHECK (camera_motion_energy IS NULL OR (camera_motion_energy >= 0 AND camera_motion_energy <= 1)),
  motion_type TEXT NOT NULL CHECK (
    motion_type IN ('static', 'pan', 'tilt', 'push_in', 'pull_out', 'tracking', 'handheld', 'fast_action', 'reveal', 'unknown')
  ),
  dominant_motion_is_camera INTEGER NOT NULL DEFAULT 0 CHECK (dominant_motion_is_camera IN (0, 1)),
  action_start_us INTEGER CHECK (action_start_us IS NULL OR action_start_us >= 0),
  action_end_us INTEGER CHECK (action_end_us IS NULL OR action_end_us >= 0),
  source_event_id TEXT REFERENCES marlin_events(event_id) ON DELETE SET NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_action_flow_direction ON segment_action_flow(action_direction, motion_energy);

CREATE TABLE segment_visual_signature (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  frame_us INTEGER CHECK (frame_us IS NULL OR frame_us >= 0),
  frame_path TEXT,
  shot_scale TEXT NOT NULL CHECK (
    shot_scale IN ('extreme_close', 'close', 'medium_close', 'medium', 'medium_wide', 'wide', 'extreme_wide', 'unknown')
  ),
  composition_anchor TEXT NOT NULL CHECK (
    composition_anchor IN ('left', 'center_left', 'center', 'center_right', 'right', 'unknown')
  ),
  subject_center_x REAL CHECK (subject_center_x IS NULL OR (subject_center_x >= 0 AND subject_center_x <= 1)),
  subject_center_y REAL CHECK (subject_center_y IS NULL OR (subject_center_y >= 0 AND subject_center_y <= 1)),
  subject_area_ratio REAL CHECK (subject_area_ratio IS NULL OR (subject_area_ratio >= 0 AND subject_area_ratio <= 1)),
  horizon_y REAL CHECK (horizon_y IS NULL OR (horizon_y >= 0 AND horizon_y <= 1)),
  color_temperature TEXT NOT NULL CHECK (color_temperature IN ('cool', 'neutral', 'warm', 'mixed', 'unknown')),
  warmth_score REAL CHECK (warmth_score IS NULL OR (warmth_score >= 0 AND warmth_score <= 1)),
  brightness_score REAL CHECK (brightness_score IS NULL OR (brightness_score >= 0 AND brightness_score <= 1)),
  contrast_score REAL CHECK (contrast_score IS NULL OR (contrast_score >= 0 AND contrast_score <= 1)),
  saturation_score REAL CHECK (saturation_score IS NULL OR (saturation_score >= 0 AND saturation_score <= 1)),
  dominant_colors_json TEXT NOT NULL DEFAULT '[]',
  shape_tags_json TEXT NOT NULL DEFAULT '[]',
  object_tags_json TEXT NOT NULL DEFAULT '[]',
  visual_hash TEXT,
  visual_embedding_model_id TEXT,
  visual_embedding BLOB,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_visual_signature_anchor ON segment_visual_signature(shot_scale, composition_anchor, color_temperature);
```

### Temporal context and energy profile

```sql
CREATE TABLE segment_temporal_context (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  session_id TEXT,
  capture_order INTEGER,
  capture_basis TEXT NOT NULL CHECK (
    capture_basis IN ('manifest_timecode', 'file_metadata', 'source_order_window', 'user_annotation', 'unknown')
  ),
  narrative_day_id TEXT,
  narrative_day_basis TEXT CHECK (
    narrative_day_basis IS NULL OR narrative_day_basis IN ('user_annotation', 'wardrobe', 'lighting', 'source_metadata', 'unknown')
  ),
  wardrobe_signature TEXT,
  wardrobe_label TEXT,
  lighting_signature TEXT,
  time_of_day_label TEXT NOT NULL CHECK (
    time_of_day_label IN ('morning', 'midday', 'afternoon', 'golden_hour', 'evening', 'night', 'indoor_unknown', 'unknown')
  ),
  time_of_day_basis TEXT NOT NULL CHECK (
    time_of_day_basis IN ('source_metadata', 'user_annotation', 'sun_angle', 'color_temperature', 'marlin_text', 'unknown')
  ),
  continuity_confidence REAL NOT NULL CHECK (continuity_confidence >= 0 AND continuity_confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_temporal_context_session ON segment_temporal_context(session_id, capture_order);
CREATE INDEX idx_temporal_context_day ON segment_temporal_context(narrative_day_id, time_of_day_label);

CREATE TABLE segment_energy_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  motion_energy REAL CHECK (motion_energy IS NULL OR (motion_energy >= 0 AND motion_energy <= 1)),
  audio_loudness_lufs REAL,
  audio_peak_dbfs REAL,
  audio_rms REAL CHECK (audio_rms IS NULL OR audio_rms >= 0),
  speech_density REAL CHECK (speech_density IS NULL OR (speech_density >= 0 AND speech_density <= 1)),
  music_density REAL CHECK (music_density IS NULL OR (music_density >= 0 AND music_density <= 1)),
  silence_head_us INTEGER CHECK (silence_head_us IS NULL OR silence_head_us >= 0),
  silence_tail_us INTEGER CHECK (silence_tail_us IS NULL OR silence_tail_us >= 0),
  natural_sound_interest REAL CHECK (natural_sound_interest IS NULL OR (natural_sound_interest >= 0 AND natural_sound_interest <= 1)),
  emotional_intensity REAL CHECK (emotional_intensity IS NULL OR (emotional_intensity >= 0 AND emotional_intensity <= 1)),
  emotional_phase TEXT NOT NULL CHECK (emotional_phase IN ('calm', 'building', 'peak', 'resolving', 'neutral', 'unknown')),
  min_read_duration_us INTEGER CHECK (min_read_duration_us IS NULL OR min_read_duration_us >= 0),
  preferred_duration_us INTEGER CHECK (preferred_duration_us IS NULL OR preferred_duration_us >= 0),
  max_compress_duration_us INTEGER CHECK (max_compress_duration_us IS NULL OR max_compress_duration_us >= 0),
  can_work_as_flash INTEGER NOT NULL DEFAULT 0 CHECK (can_work_as_flash IN (0, 1)),
  can_work_as_texture INTEGER NOT NULL DEFAULT 0 CHECK (can_work_as_texture IN (0, 1)),
  needs_context_preroll INTEGER NOT NULL DEFAULT 0 CHECK (needs_context_preroll IN (0, 1)),
  needs_post_action_hold INTEGER NOT NULL DEFAULT 0 CHECK (needs_post_action_hold IN (0, 1)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_energy_profile_motion ON segment_energy_profile(motion_energy, emotional_phase);
CREATE INDEX idx_energy_profile_read ON segment_energy_profile(preferred_duration_us, can_work_as_texture);
```

### Transition affordances and pair compatibility

```sql
CREATE TABLE segment_transition_affordances (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  clean_in_score REAL CHECK (clean_in_score IS NULL OR (clean_in_score >= 0 AND clean_in_score <= 1)),
  clean_out_score REAL CHECK (clean_out_score IS NULL OR (clean_out_score >= 0 AND clean_out_score <= 1)),
  hard_cut_in_score REAL CHECK (hard_cut_in_score IS NULL OR (hard_cut_in_score >= 0 AND hard_cut_in_score <= 1)),
  hard_cut_out_score REAL CHECK (hard_cut_out_score IS NULL OR (hard_cut_out_score >= 0 AND hard_cut_out_score <= 1)),
  dissolve_in_score REAL CHECK (dissolve_in_score IS NULL OR (dissolve_in_score >= 0 AND dissolve_in_score <= 1)),
  dissolve_out_score REAL CHECK (dissolve_out_score IS NULL OR (dissolve_out_score >= 0 AND dissolve_out_score <= 1)),
  j_cut_in_score REAL CHECK (j_cut_in_score IS NULL OR (j_cut_in_score >= 0 AND j_cut_in_score <= 1)),
  l_cut_out_score REAL CHECK (l_cut_out_score IS NULL OR (l_cut_out_score >= 0 AND l_cut_out_score <= 1)),
  dip_to_black_out_score REAL CHECK (dip_to_black_out_score IS NULL OR (dip_to_black_out_score >= 0 AND dip_to_black_out_score <= 1)),
  endpoint_score REAL CHECK (endpoint_score IS NULL OR (endpoint_score >= 0 AND endpoint_score <= 1)),
  afterglow_score REAL CHECK (afterglow_score IS NULL OR (afterglow_score >= 0 AND afterglow_score <= 1)),
  audio_handle_head_us INTEGER CHECK (audio_handle_head_us IS NULL OR audio_handle_head_us >= 0),
  audio_handle_tail_us INTEGER CHECK (audio_handle_tail_us IS NULL OR audio_handle_tail_us >= 0),
  incoming_audio_interest REAL CHECK (incoming_audio_interest IS NULL OR (incoming_audio_interest >= 0 AND incoming_audio_interest <= 1)),
  outgoing_audio_hold_interest REAL CHECK (outgoing_audio_hold_interest IS NULL OR (outgoing_audio_hold_interest >= 0 AND outgoing_audio_hold_interest <= 1)),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_transition_affordances_jl ON segment_transition_affordances(j_cut_in_score, l_cut_out_score);
CREATE INDEX idx_transition_affordances_dip ON segment_transition_affordances(dip_to_black_out_score, endpoint_score);

CREATE TABLE segment_pair_compatibility (
  left_segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  right_segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  pair_type TEXT NOT NULL CHECK (
    pair_type IN ('axis_continuity', 'shot_reverse', 'match_cut', 'dissolve', 'hard_cut', 'j_cut', 'l_cut', 'dip_to_black', 'breathing_room')
  ),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  recommended_transition_type TEXT CHECK (
    recommended_transition_type IS NULL OR recommended_transition_type IN ('cut', 'crossfade', 'j_cut', 'l_cut', 'match_cut', 'fade_to_black')
  ),
  same_scene_space INTEGER CHECK (same_scene_space IS NULL OR same_scene_space IN (0, 1)),
  axis_id TEXT REFERENCES continuity_axes(axis_id) ON DELETE SET NULL,
  axis_consistency_score REAL CHECK (axis_consistency_score IS NULL OR (axis_consistency_score >= 0 AND axis_consistency_score <= 1)),
  axis_break_risk TEXT CHECK (
    axis_break_risk IS NULL OR axis_break_risk IN ('none', 'low', 'medium', 'high')
  ),
  axis_break_allowed INTEGER NOT NULL DEFAULT 0 CHECK (axis_break_allowed IN (0, 1)),
  axis_break_allow_basis TEXT CHECK (
    axis_break_allow_basis IS NULL OR axis_break_allow_basis IN ('neutral_reset', 'camera_crosses_line', 'scene_break', 'intentional_disorientation', 'user_annotation', 'unknown')
  ),
  opposing_gaze_score REAL CHECK (opposing_gaze_score IS NULL OR (opposing_gaze_score >= 0 AND opposing_gaze_score <= 1)),
  eyeline_height_delta REAL CHECK (eyeline_height_delta IS NULL OR eyeline_height_delta >= 0),
  composition_match_score REAL CHECK (composition_match_score IS NULL OR (composition_match_score >= 0 AND composition_match_score <= 1)),
  motion_match_score REAL CHECK (motion_match_score IS NULL OR (motion_match_score >= 0 AND motion_match_score <= 1)),
  tone_match_score REAL CHECK (tone_match_score IS NULL OR (tone_match_score >= 0 AND tone_match_score <= 1)),
  shape_match_score REAL CHECK (shape_match_score IS NULL OR (shape_match_score >= 0 AND shape_match_score <= 1)),
  energy_delta_score REAL CHECK (energy_delta_score IS NULL OR (energy_delta_score >= 0 AND energy_delta_score <= 1)),
  reason TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  risk_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (left_segment_id, right_segment_id, pair_type)
);

CREATE INDEX idx_pair_type_score ON segment_pair_compatibility(pair_type, score DESC);
CREATE INDEX idx_pair_right_type ON segment_pair_compatibility(right_segment_id, pair_type, score DESC);
```

## 12. Search API Additions

Extend `FootageSearchFilters` with optional fields. These should compile to
structured SQL filters and warnings when indexed metadata is missing.

```ts
export type Direction = "left" | "right" | "camera" | "away" | "unknown";
export type ActionDirection = "ltr" | "rtl" | "toward_camera" | "away_camera" | "static" | "mixed" | "unknown";
export type ShotScale =
  | "extreme_close"
  | "close"
  | "medium_close"
  | "medium"
  | "medium_wide"
  | "wide"
  | "extreme_wide"
  | "unknown";

export interface EditorialGrammarFilters {
  scene_space_id?: string;
  same_scene_as_segment_id?: string;
  different_angle_from_segment_id?: string;
  subject_ref?: string;
  entity_id?: string;
  screen_side?: "left" | "center" | "right" | "mixed" | "unknown";
  facing_direction?: Direction;
  gaze_direction?: Direction;
  action_direction?: ActionDirection;
  shot_scale?: ShotScale | ShotScale[];
  time_of_day_label?: string;
  narrative_day_id?: string;
  motion_energy_min?: number;
  motion_energy_max?: number;
  emotional_phase?: "calm" | "building" | "peak" | "resolving" | "neutral" | "unknown";
  preferred_duration_min_us?: number;
  preferred_duration_max_us?: number;
  transition_affordance?: "hard_cut" | "dissolve" | "j_cut" | "l_cut" | "dip_to_black";
  pair_with_segment_id?: string;
  pair_type?: "axis_continuity" | "shot_reverse" | "match_cut" | "dissolve" | "hard_cut" | "j_cut" | "l_cut" | "dip_to_black" | "breathing_room";
  min_pair_score?: number;
  allow_axis_break?: boolean;
}
```

For the existing flat tool adapter, these can still be passed through
`filters_json`.

## 13. Agent Query Examples

### Find a shot that matches the energy of this clip but from a different angle

Intent:

```json
{
  "query": "same scene, similar motion energy, different angle",
  "mode": "structured",
  "filters": {
    "same_scene_as_segment_id": "SEG_A",
    "different_angle_from_segment_id": "SEG_A",
    "motion_energy_min": 0.45,
    "motion_energy_max": 0.65,
    "exclude_segment_ids": ["SEG_A"]
  },
  "limit": 8
}
```

Representative SQL:

```sql
WITH anchor AS (
  SELECT
    ssm.scene_space_id,
    ssm.camera_angle_id,
    ep.motion_energy
  FROM segment_scene_membership ssm
  JOIN segment_energy_profile ep ON ep.segment_id = ssm.segment_id
  WHERE ssm.segment_id = :anchor_segment_id
)
SELECT
  s.segment_id,
  s.asset_id,
  s.summary,
  ep.motion_energy,
  ssm.camera_angle_id
FROM segments s
JOIN segment_scene_membership ssm ON ssm.segment_id = s.segment_id
JOIN segment_energy_profile ep ON ep.segment_id = s.segment_id
JOIN anchor a ON a.scene_space_id = ssm.scene_space_id
WHERE s.segment_id <> :anchor_segment_id
  AND COALESCE(ssm.camera_angle_id, '') <> COALESCE(a.camera_angle_id, '')
  AND ABS(ep.motion_energy - a.motion_energy) <= 0.15
ORDER BY ABS(ep.motion_energy - a.motion_energy), s.src_in_us;
```

### What calm, wide shots can I use as breathing room after this fast montage?

Intent:

```json
{
  "query": "calm wide breathing room after fast montage",
  "mode": "hybrid",
  "filters": {
    "shot_scale": ["wide", "extreme_wide", "medium_wide"],
    "motion_energy_max": 0.35,
    "emotional_phase": "calm",
    "preferred_duration_min_us": 5000000,
    "exclude_quality_flags": ["blur", "bad_audio"]
  },
  "limit": 12
}
```

Representative SQL:

```sql
SELECT
  s.segment_id,
  s.asset_id,
  s.summary,
  vs.shot_scale,
  ep.motion_energy,
  ep.emotional_phase,
  ep.preferred_duration_us
FROM segments s
JOIN segment_visual_signature vs ON vs.segment_id = s.segment_id
JOIN segment_energy_profile ep ON ep.segment_id = s.segment_id
WHERE vs.shot_scale IN ('wide', 'extreme_wide', 'medium_wide')
  AND ep.motion_energy <= 0.35
  AND ep.emotional_phase IN ('calm', 'resolving', 'neutral')
  AND COALESCE(ep.preferred_duration_us, s.duration_us) >= 5000000
ORDER BY ep.motion_energy ASC, COALESCE(ep.preferred_duration_us, s.duration_us) DESC
LIMIT :limit;
```

### Find clips where the subject is looking left to match this right-facing close-up

Intent:

```json
{
  "query": "reverse close-up looking left, same scene if possible",
  "mode": "structured",
  "filters": {
    "pair_with_segment_id": "SEG_RIGHT_CU",
    "pair_type": "shot_reverse",
    "min_pair_score": 0.7,
    "gaze_direction": "left",
    "shot_scale": ["close", "medium_close"]
  },
  "limit": 10
}
```

Representative SQL:

```sql
SELECT
  right_s.segment_id,
  right_s.asset_id,
  right_s.summary,
  sp.subject_ref,
  sp.gaze_direction,
  sp.eyeline_y,
  pc.score,
  pc.eyeline_height_delta,
  pc.reason
FROM segment_pair_compatibility pc
JOIN segments right_s ON right_s.segment_id = pc.right_segment_id
JOIN segment_subject_presence sp ON sp.segment_id = right_s.segment_id
WHERE pc.left_segment_id = :anchor_segment_id
  AND pc.pair_type = 'shot_reverse'
  AND pc.score >= 0.70
  AND sp.gaze_direction = 'left'
  AND sp.shot_scale IN ('close', 'medium_close')
ORDER BY pc.score DESC, pc.eyeline_height_delta ASC;
```

### Find a dissolve bridge between two different topics

```sql
SELECT
  pc.left_segment_id,
  pc.right_segment_id,
  pc.score,
  pc.composition_match_score,
  pc.tone_match_score,
  pc.reason
FROM segment_pair_compatibility pc
WHERE pc.pair_type = 'dissolve'
  AND pc.recommended_transition_type = 'crossfade'
  AND pc.score >= 0.70
  AND COALESCE(pc.motion_match_score, 0) <= 0.50
ORDER BY pc.score DESC
LIMIT 12;
```

### Find possible intentional line-crossing moments

```sql
SELECT
  left_segment_id,
  right_segment_id,
  score,
  axis_break_risk,
  axis_break_allow_basis,
  reason
FROM segment_pair_compatibility
WHERE pair_type = 'axis_continuity'
  AND axis_break_risk IN ('medium', 'high')
  AND axis_break_allowed = 1
ORDER BY score DESC;
```

## 14. Practical Rollout

### Phase 1: Index existing evidence

No new media analysis.

- Ingest `continuity_graph.json` into scene/entity references.
- Copy or derive shot scale, composition anchor, screen side, gaze direction,
  camera axis, and pair scores when adjacency evidence already exists.
- Map Marlin events into action windows and rough action/reaction labels.
- Add search filters for scene, direction, energy, and pair type.

Acceptance:

- Existing DB builds still work when these tables are absent.
- Search returns warnings when editorial grammar tables are missing.
- No canonical schema changes.

### Phase 2: Local frame/audio features

Add deterministic analysis from sampled frames and audio.

- OpenCV color, brightness, shape, visual hash, optical flow.
- FFmpeg audio energy, silence, and handle measurements.
- Populate energy profile, visual signature, transition affordances.

Acceptance:

- Rebuilding the DB produces deterministic values for fixed fixture media.
- Motion energy ignores obvious camera setup motion when Marlin/camera-motion
  evidence indicates camera movement.
- Pair compatibility has evidence refs and confidence.

### Phase 3: Optional pose/face/body analysis

Add stronger but privacy-sensitive visual analysis.

- MediaPipe face/body/pose for gaze, eyeline, subject boxes, gesture phase.
- Optional local subject clustering with explicit project setting.
- Redaction support for subject labels and identity refs.

Acceptance:

- Identity matching can be disabled without breaking screen grammar.
- Unknown subjects still produce screen side and gaze metadata.
- User annotation can override or reject inferred identity/scene groups.

### Phase 4: Fine-cut and polish integration

Use pair compatibility in agent and compiler workflows.

- Fine pass can query targeted replacement shots by pair type.
- Review metrics can cite `axis_continuity`, `shot_reverse`, and transition
  compatibility evidence.
- Compiler transition cards can consume pair scores but must keep existing
  fallback and degradation behavior.

Acceptance:

- `j_cut` and `l_cut` metadata can be searched before full audio-overlap
  execution is enabled, but compile degrades or warns if execution is not
  supported.
- Intentional line crossing requires evidence or annotation.
- Match-cut recommendations require frame-level visual evidence in polish mode.

## 15. Risks and Constraints

### False precision

Screen direction and gaze are easy to overstate. Every row needs confidence and
evidence basis. Low-confidence geometry should rank lower and create warnings.

### Identity privacy

Subject tracking is editorially useful but sensitive. The default should be
anonymous local refs. Named identity and face/person re-identification should be
opt-in and redactable.

### Pair explosion

Pair compatibility can grow as O(n squared). For typical projects below 1,000
segments this is still tractable, but the builder should prune:

- same scene pairs for axis and shot-reverse
- high visual-similarity candidates for match cuts
- low-motion candidates for dissolves
- adjacent/source-near pairs for temporal continuity

### Overconstraining the rough cut

Rough cut should not become a continuity prison. Unknown or medium-risk metadata
should guide candidate choice and report warnings. Fine cut and polish should
make stricter decisions.

### Current execution limits

The runtime can represent transition types like `j_cut` and `l_cut`, but the
craft design currently treats audio-overlap execution as deferred. Metadata can
prepare for the feature; it should not imply the compiler can execute it today.

## 16. Verification Strategy

- DB integrity: `PRAGMA integrity_check` after schema additions.
- Missing-table fallback: search still works with only base footage DB tables.
- Deterministic fixtures: repeated builds produce stable motion/color/audio
  scores for fixture clips.
- Pair scoring fixtures:
  - same scene, opposite gaze close-ups produce `shot_reverse` rows.
  - action left-to-right followed by right-to-left in same scene warns unless
    a reset/intent annotation exists.
  - low-motion similar-composition different-content pairs rank as dissolves.
  - high-confidence visual/shape matches rank as match cuts.
- Agent behavior:
  - search-derived replacement suggestions cite segment ids, evidence refs, and
    pair reasons.
  - missing geometry produces uncertainty, not invented continuity facts.

## 17. Self-Review

Score: 93/100.

Strengths:

- Covers the requested editorial grammar areas with concrete metadata and exact
  additive SQLite tables.
- Separates practical current extraction from ideal frame-level/pose analysis.
- Preserves the repo's derived-DB and schema-safe planning boundaries.
- Maps metadata to rough cut, fine cut, and polish workflows.

Remaining gaps:

- Exact thresholds for motion, color, eyeline, and pair scores need calibration
  against real project footage.
- The user annotation storage artifact is named conceptually here but should get
  its own small design before implementation.
- Visual embedding provider choice is intentionally left optional because the
  current DB design only approves local text embeddings.
