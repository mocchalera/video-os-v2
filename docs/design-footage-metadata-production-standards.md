# Footage Metadata Design: Production And Post-production Standards

Date: 2026-06-19
Status: Design proposal
Scope: design only. No code, schema, or runtime change is made by this document.

## 1. Technical Metadata: Camera Original

Professional NLEs and post-production facilities expect enough technical metadata to answer four practical questions:

- Can this source be decoded and relinked?
- Can it be cut into the current timeline without frame-rate, timecode, rotation, or audio-channel surprises?
- Will it grade consistently with adjacent shots?
- Can it round-trip to XML/EDL or another editor with stable source references?

The current connector already uses `ffprobe -show_format -show_streams -print_format json`, which exposes format-level and stream-level metadata. The implementation persists only a small normalized subset in `assets.json`.

| Metadata | Current repo state | Practical recommendation |
| --- | --- | --- |
| Duration | `duration_us` from `format.duration`, with stream fallback | Keep as canonical asset duration. Also record stream durations when they disagree, because A/V duration mismatch matters for conform. |
| Codec | `video_stream.codec` and `audio_stream.codec` from first video/audio streams | Keep current fields, but add profile, codec tag, pixel format, and container format in the derived DB. |
| Resolution | `video_stream.width` and `height` | Already enough for rough-cut search and delivery checks. |
| Frame rate | `video_stream.fps_num` and `fps_den` from `avg_frame_rate` | Add `r_frame_rate`, `time_base`, and `frame_rate_mode` when derivable. VFR phone footage should be visible before export. |
| Bit depth | Not persisted | Add from `bits_per_raw_sample`, `bits_per_sample`, `pix_fmt`, or MediaInfo when available. |
| Color space | Not persisted | Add `color_primaries`, `color_transfer`, `color_space`/matrix, and `color_range`. These are compatibility facts, not creative labels. |
| Recording format | Only codec name is persisted | Add container/recording label such as QuickTime/ProRes, MP4/H.264, MXF/XAVC, BRAW/RAW when detectable. |
| Audio channels and format | First audio stream only: sample rate, channels, codec | Add all audio streams as JSON or a child table: stream index, channel layout, sample format, bit rate, language/title, default flag. |
| Timecode | Not extracted by `ffprobe.ts`; `source_media_manifest` has `timecode_start` and `timecode_format` fields if populated | Prefer `source_media_manifest` when present. Add fallback extraction from ffprobe tags, MediaInfo `TimeCode_FirstFrame`, or operator declaration. |
| Reel/card number | Not persisted | Extract from filename patterns, MediaInfo `Reel`, camera card folder names, or user context. Store source and confidence. |
| Lens metadata | Not persisted | Try ExifTool/BRAW SDK for focal length, iris/aperture, focus distance, ISO, shutter, camera make/model. Do not infer exact lens facts from image content. |
| Rotation/orientation | Not persisted in `assets.json`; `source_media_manifest` has `rotation` | Index manifest value when present and fallback to stream side data/tags. Phone footage needs this for preview/export correctness. |
| Media hash for relinking | `source_fingerprint` is a SHA-1 over first 16 MB plus file size, duration, and stream signature | Keep for compatibility, but prefer full `sha256` `content_hash` from `source_media_manifest` when available. |

The derivative generator currently creates contact sheets, overview contact sheets, posters, segment filmstrips, and waveform images. It does not compute numeric color, exposure, audio-level, loudness, or noise metrics.

Practical decision: do not expand `segments.json` or `assets.json` first. Add production metadata to the derived footage DB and optional analysis sidecars. Canonical schemas can remain stable until a field proves it affects multiple downstream workflows.

## 2. Color And Exposure Metadata

Color metadata should be split into two different categories:

- Technical color facts from the file: color primaries, transfer, matrix, range, bit depth, pixel format, HDR flags.
- Editorial color traits from sampled frames: exposure label, warmth/coolness, palette, contrast, saturation.

For AI rough-cut editing, the second category helps with continuity. It can answer queries like "find a warm indoor cutaway that will match the interview" or "avoid overexposed exterior shots."

Recommended segment-level fields:

| Field | Type | Extraction | Editing value |
| --- | --- | --- | --- |
| `exposure_label` | `under`, `normal`, `over`, `mixed`, `unknown` | Luma histogram from sampled frames, with clipped black/white percentages | Avoids unusable shots and helps continuity. |
| `exposure_score` | 0-1 | Derived confidence/quality score | Lets search sort stronger matches without hard filtering. |
| `color_temperature_label` | `warm`, `neutral`, `cool`, `mixed`, `unknown` | Average chroma/white-balance heuristic plus VLM label fallback | Helps grade-compatible sequence building. |
| `dominant_colors_json` | array of hex/color names with percentages | Sampled frame palette quantization | Lets the agent match brand/product/place palettes. |
| `contrast_label` | `low`, `normal`, `high`, `mixed`, `unknown` | Luma percentile ratio, not subjective VLM wording alone | Helps avoid cutting flat log-like footage against high-contrast shots by accident. |
| `saturation_label` | `muted`, `normal`, `vivid`, `mixed`, `unknown` | HSV/chroma statistics | Helps visual continuity and mood grouping. |
| `color_profile_source` | `file_metadata`, `frame_stats`, `vlm`, `mixed` | Provenance | Prevents treating inferred labels like camera-original facts. |

Existing `visual_quality.scores.light_quality` is useful but not the same as exposure. A shot can have good light quality and still be deliberately underexposed, or technically overexposed but compositionally usable. Keep the existing visual-quality model, and add deterministic frame-stat fields beside it in the derived DB.

## 3. Audio Characteristics

NLE users expect audio to be searchable and mix-safe. The current repo has transcript excerpts, `segment_type`, waveform images, and `peak_analysis.support_signals.audio_support_score`. It does not persist numeric levels, loudness, silence, noise, or channel-purpose metadata.

Recommended segment-level audio fields:

| Field | Type | Extraction | Editing value |
| --- | --- | --- | --- |
| `audio_role` | `dialogue`, `music`, `ambient`, `silence`, `mixed`, `unknown` | STT/VAD, music classifier, silence detection, transcript overlap, existing `segment_type` | Separates A-roll from B-roll and avoids accidental dialogue underlays. |
| `has_dialogue` | boolean | Existing transcript/STT plus VAD | Already represented partly by transcript text; should be explicit for filters. |
| `has_music` | boolean | Audio classifier or spectral/music heuristic | Avoids cutting copyrighted/music-heavy source under a new BGM bed. |
| `has_ambient` | boolean | Classifier/VLM/context fallback | Useful for room tone and natural sound bridges. |
| `peak_dbfs` | number | `ffmpeg`/`astats` or similar | Finds clipping and sets trim warnings. |
| `rms_dbfs` | number | `ffmpeg`/`astats` | Rough mix compatibility. |
| `integrated_lufs` | number | `ffmpeg` `ebur128` or a loudness analyzer | Better than RMS for dialogue/music loudness matching. |
| `silence_ratio` | 0-1 | `silencedetect` windows | Identifies room tone or silent visuals. |
| `noise_flags_json` | array | Wind/handling/clipping/hum classifiers plus deterministic clipping checks | Avoids technically poor audio when selecting A-roll. |
| `room_tone_label` | `clean`, `hissy`, `reverberant`, `windy`, `crowded`, `unknown` | Classifier, context interview, or manual note | Helps choose ambient beds and dialogue-safe takes. |

Do not rely on Marlin alone for audio technical facts. Marlin can describe events and audiovisual semantics, but LUFS, peak, RMS, channel layout, clipping, and silence need dedicated extraction.

## 4. Logging And Organization Metadata

Editors expect logging fields that help navigate a shoot, not just search semantic descriptions. For this project, the useful subset is:

| Field | Source | Practical use |
| --- | --- | --- |
| `scene_number` | Filename/folder regex or user note | Groups related shots and takes. |
| `shot_number` | Filename/folder regex or user note | Helps alternate-angle search. |
| `take_number` | Filename/folder regex or user note | Enables "best take" comparison. |
| `camera_id` | Filename, card folder, metadata tag, user note | Useful for multicam or camera-style continuity. |
| `card_id` / `reel_name` | Folder/filename, MediaInfo, operator note | Relinking and NLE export compatibility. |
| `circle_take` | User context, slate notes, explicit filename marker | High-value selection signal; do not infer from image quality alone. |
| `best_take` | User context, reviewer/editor note | High-value selection signal; model guesses should remain suggestions. |
| `operator_notes` | Context interview or imported notes | Searchable editorial intent. |
| `usability_rating` | deterministic rules plus optional human override | Supports "fully usable", "partially usable", "unusable" filtering. |
| `roll_classification` | current `role_guess`, segment `segment_type`, STT/VLM/context | Distinguishes A-roll, B-roll, cutaway, natural sound, insert, texture. |

Filename parsing must be deterministic and confidence-scored. Examples: `SC03_SH02_TK04`, `scene03-shot02-take04`, `A012_C003`, `CAM_A`, `CARD_02`. If a pattern is not configured, leave fields null and record a warning rather than inventing production facts.

`usability_rating` should be a search/ranking aid, not a final reject gate. Suggested rule:

- `fully_usable`: no hard quality flags, acceptable exposure/audio, sufficient duration.
- `partially_usable`: useful visual content but trim, stabilization, audio replacement, or color correction is likely needed.
- `unusable`: black/frozen/corrupt, severe focus/exposure failure, or unusable audio for required dialogue.

## 5. Conforming Metadata

Full conform management is not the goal. The rough-cut system only needs enough source identity and timing data to hand off reliably to Premiere, Resolve, FCP, XML/EDL, or a future packaging step.

Recommended source-level fields:

| Field | Current state | Recommendation |
| --- | --- | --- |
| `source_locator` | Present in `assets.json` when safely project-relative | Keep as the primary human-readable relink path. |
| `source_fingerprint` | Present, partial SHA-1-derived fingerprint | Keep for backward compatibility. |
| `content_hash` | Present in `source_media_manifest` if generated | Prefer for relink verification and stale detection. |
| `timecode_start` | Present in `source_media_manifest` schema, not in current `assets.json` | Index into footage DB when available. |
| `timecode_format` | Present in `source_media_manifest` schema | Use for drop/non-drop display and XML/EDL export. |
| `source_frame_rate` | Partly present via `fps_num`/`fps_den` | Add exact rate basis and frame-rate mode for timecode math. |
| `reel_name` | Missing | Extract from manifest, MediaInfo, folder/filename, or user note. |
| `proxy_locator` | Missing | Do not add until edit proxies exist. Contact sheets/filmstrips/waveforms are analysis derivatives, not NLE proxies. |

Source timecode to timeline timecode mapping is timeline-specific. The footage DB should store the source basis; the timeline/export step should emit mapping rows such as:

```text
timeline_clip_id
asset_id
segment_id
source_locator
source_tc_in
source_tc_out
timeline_tc_in
timeline_tc_out
reel_name
fps_num
fps_den
timecode_format
content_hash
```

This keeps the footage database reusable across multiple rough cuts while still supporting conform reports and XML/EDL export.

## 6. Existing NLE Metadata Standards

Professional standards are useful as references, but the project should adopt only the parts that improve AI rough-cut decisions and handoff reliability.

| Standard/source | What it defines | Relevant for AI rough cuts | Overkill for this use case |
| --- | --- | --- | --- |
| MXF / SMPTE-style metadata | Essence, structural metadata, descriptive metadata, packages, tracks, descriptors, timecode, audio/video synchronization | Technical essence facts, timecode, track/source identity, descriptive notes | Full KLV model, operational patterns, package graph, UMID-heavy broadcast archive workflows. |
| Blackmagic RAW sidecar/metadata | Embedded and sidecar metadata, camera/lens/iris/ISO/color-space metadata, frame-based metadata such as focus distance | Use when `.braw` is a source format; sidecar JSON is valuable for lens/color metadata | Requiring BRAW SDK for all footage; reproducing Resolve's RAW settings database. |
| FCPXML / FCP XML | Clips, media/file references, rate, duration, in/out, timecode, media, logging info, labels, comments, markers | Export compatibility and minimal conform mapping | Replicating FCP libraries, events, compound clips, effects, roles, and full timeline semantics in the footage DB. |
| MediaInfo field model | Container, video, audio, timecode, color, reel, package, and descriptive fields across formats | Good extraction fallback for reel, timecode, color primaries, transfer/matrix, stream format/profile | Treating every possible MediaInfo field as searchable metadata. |
| ExifTool / QuickTime tags | Broad file metadata extraction, especially MOV/MP4 camera and QuickTime tags | Useful for creation time, camera/lens tags, rotation, vendor-specific metadata | Writing metadata back to originals or relying on every camera to provide consistent tags. |

References:

- FFmpeg ffprobe documentation: https://ffmpeg.org/ffprobe.html
- MXF media type overview: https://datatracker.ietf.org/doc/html/rfc4539
- AMWA AS-11 vocabulary for MXF concepts: https://amwa-tv.github.io/AS-11_X10/AMWA_AS_11_X10.html
- Blackmagic RAW metadata/sidecar overview: https://www.blackmagicdesign.com/products/blackmagicraw
- Apple FCPXML reference: https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference
- Apple Final Cut Pro XML archive elements: https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html
- MediaInfo field reference: https://mediaarea.net/en/MediaInfo/Support/Fields
- ExifTool overview and QuickTime tags: https://exiftool.org/ and https://exiftool.org/TagNames/QuickTime.html

## 7. Database Schema Additions

Add only practical derived-DB tables. Do not replicate a full NLE project database, and do not move source of truth from canonical artifacts into SQLite.

Recommended inputs for a future `footage.db` v2 build:

- `03_analysis/assets.json`
- `03_analysis/segments.json`
- `03_analysis/marlin_events.json`
- `03_analysis/transcripts/*.json`
- `02_media/source_media_manifest.json` when present
- Optional new derived sidecar: `03_analysis/source_technical_metadata.json`
- Optional new derived sidecar: `03_analysis/segment_media_profiles.json`

The sidecars are recommended because the current closed canonical schemas do not have room for raw technical extraction output, and because rebuilding the DB from existing project artifacts should not always require original media access.

Proposed SQLite tables:

```sql
CREATE TABLE asset_technical_metadata (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  container_format TEXT,
  recording_format TEXT,
  video_codec TEXT,
  video_profile TEXT,
  codec_tag TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  fps_num INTEGER CHECK (fps_num IS NULL OR fps_num > 0),
  fps_den INTEGER CHECK (fps_den IS NULL OR fps_den > 0),
  frame_rate_mode TEXT CHECK (frame_rate_mode IS NULL OR frame_rate_mode IN ('cfr', 'vfr', 'audio_only', 'unknown')),
  pix_fmt TEXT,
  bit_depth INTEGER CHECK (bit_depth IS NULL OR bit_depth > 0),
  color_primaries TEXT,
  color_transfer TEXT,
  color_space TEXT,
  color_range TEXT,
  rotation INTEGER CHECK (rotation IS NULL OR rotation IN (0, 90, 180, 270)),
  timecode_start TEXT,
  timecode_format TEXT CHECK (timecode_format IS NULL OR timecode_format IN ('none', 'non_drop', 'drop_frame', 'inferred', 'unknown')),
  reel_name TEXT,
  card_id TEXT,
  camera_make TEXT,
  camera_model TEXT,
  lens_metadata_json TEXT NOT NULL DEFAULT '{}',
  audio_streams_json TEXT NOT NULL DEFAULT '[]',
  metadata_source_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_asset_technical_format ON asset_technical_metadata(recording_format, video_codec);
CREATE INDEX idx_asset_technical_color ON asset_technical_metadata(color_primaries, color_transfer, color_space);
CREATE INDEX idx_asset_technical_reel ON asset_technical_metadata(reel_name, card_id);

CREATE TABLE segment_color_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  exposure_label TEXT CHECK (exposure_label IN ('under', 'normal', 'over', 'mixed', 'unknown')),
  exposure_score REAL CHECK (exposure_score IS NULL OR (exposure_score >= 0 AND exposure_score <= 1)),
  clipped_black_pct REAL CHECK (clipped_black_pct IS NULL OR clipped_black_pct >= 0),
  clipped_white_pct REAL CHECK (clipped_white_pct IS NULL OR clipped_white_pct >= 0),
  color_temperature_label TEXT CHECK (color_temperature_label IN ('warm', 'neutral', 'cool', 'mixed', 'unknown')),
  contrast_label TEXT CHECK (contrast_label IN ('low', 'normal', 'high', 'mixed', 'unknown')),
  saturation_label TEXT CHECK (saturation_label IN ('muted', 'normal', 'vivid', 'mixed', 'unknown')),
  dominant_colors_json TEXT NOT NULL DEFAULT '[]',
  sampled_frame_count INTEGER NOT NULL DEFAULT 0 CHECK (sampled_frame_count >= 0),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source TEXT NOT NULL DEFAULT 'frame_stats'
);

CREATE INDEX idx_segment_color_exposure ON segment_color_profile(exposure_label, exposure_score);
CREATE INDEX idx_segment_color_temperature ON segment_color_profile(color_temperature_label);
CREATE INDEX idx_segment_color_contrast ON segment_color_profile(contrast_label);

CREATE TABLE segment_audio_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  audio_role TEXT CHECK (audio_role IN ('dialogue', 'music', 'ambient', 'silence', 'mixed', 'unknown')),
  has_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (has_dialogue IN (0, 1)),
  has_music INTEGER NOT NULL DEFAULT 0 CHECK (has_music IN (0, 1)),
  has_ambient INTEGER NOT NULL DEFAULT 0 CHECK (has_ambient IN (0, 1)),
  peak_dbfs REAL,
  rms_dbfs REAL,
  integrated_lufs REAL,
  silence_ratio REAL CHECK (silence_ratio IS NULL OR (silence_ratio >= 0 AND silence_ratio <= 1)),
  room_tone_label TEXT CHECK (room_tone_label IS NULL OR room_tone_label IN ('clean', 'hissy', 'reverberant', 'windy', 'crowded', 'unknown')),
  noise_flags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source TEXT NOT NULL DEFAULT 'audio_analysis'
);

CREATE INDEX idx_segment_audio_role ON segment_audio_profile(audio_role);
CREATE INDEX idx_segment_audio_dialogue ON segment_audio_profile(has_dialogue);
CREATE INDEX idx_segment_audio_levels ON segment_audio_profile(peak_dbfs, integrated_lufs);

CREATE TABLE logging_metadata (
  asset_id TEXT REFERENCES assets(asset_id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments(segment_id) ON DELETE CASCADE,
  scene_number TEXT,
  shot_number TEXT,
  take_number TEXT,
  camera_id TEXT,
  circle_take INTEGER CHECK (circle_take IS NULL OR circle_take IN (0, 1)),
  best_take INTEGER CHECK (best_take IS NULL OR best_take IN (0, 1)),
  roll_classification TEXT CHECK (
    roll_classification IS NULL OR roll_classification IN ('a_roll', 'b_roll', 'cutaway', 'insert', 'nat_sound', 'texture', 'unknown')
  ),
  usability_rating TEXT CHECK (
    usability_rating IS NULL OR usability_rating IN ('fully_usable', 'partially_usable', 'unusable', 'unknown')
  ),
  notes TEXT,
  source TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (asset_id IS NOT NULL OR segment_id IS NOT NULL)
);

CREATE INDEX idx_logging_scene_take ON logging_metadata(scene_number, shot_number, take_number);
CREATE INDEX idx_logging_roll_classification ON logging_metadata(roll_classification);
CREATE INDEX idx_logging_usability ON logging_metadata(usability_rating);
```

Do not add these fields to the public `search_footage` API all at once. Add filters only when a concrete editorial workflow needs them:

- First: `audio_role`, `has_dialogue`, `recording_format`, `frame_rate_mode`, `exposure_label`, `color_temperature_label`, `usability_rating`.
- Later: `reel_name`, `card_id`, `scene_number`, `take_number`, `integrated_lufs`, `contrast_label`.
- Avoid at MVP: exact lens filters, proxy fields, timeline conform mapping, detailed audio channel routing.

## 8. Extraction Strategy

### ffprobe

Already available through the current connector:

- `format.duration`
- stream `codec_type`
- stream `codec_name`
- video width/height
- `avg_frame_rate`
- audio sample rate/channels
- full raw stream/format objects before the current reducer discards most fields

Extend ffprobe extraction for:

- `format.format_name`, `format.format_long_name`, `format.tags`
- stream `profile`, `codec_tag_string`, `pix_fmt`, `bits_per_raw_sample`, `color_range`, `color_space`, `color_transfer`, `color_primaries`
- `r_frame_rate`, `time_base`, `start_time`, stream durations
- stream tags and side data for rotation/timecode where present
- all audio streams, not only the first one

### MediaInfo

Use MediaInfo when ffprobe is incomplete or too codec/container-specific. It is especially useful for:

- commercial recording format names
- bit depth and chroma subsampling
- color primaries/transfer/matrix fields
- `TimeCode_FirstFrame`
- reel/package names and MXF-oriented fields
- audio channel layout and format profile

MediaInfo should be optional. The project should warn when it is unavailable and continue with ffprobe-only metadata.

### ExifTool

Use ExifTool for MOV/MP4/QuickTime and camera-specific tags:

- creation date and timezone hints
- camera make/model
- lens model, focal length, aperture/iris, ISO, shutter where embedded
- rotation/orientation tags
- vendor metadata that ffprobe and MediaInfo flatten poorly

ExifTool output must be normalized into a small allowlist. Do not store arbitrary private tag dumps in the main DB unless the DB is explicitly treated as sensitive analysis data.

### Dedicated video/audio analysis

Use `ffmpeg` filters or small local analyzers for signals that are not file metadata:

- frame histograms for exposure, contrast, clipping, saturation, and palette
- sampled frame color clustering for dominant colors
- `astats`, `ebur128`, and `silencedetect` for audio levels, loudness, and silence
- optional speech/music/noise classifiers for dialogue/music/ambient/wind/handling labels

These are derived editorial signals. Store confidence, sample count, and extractor version.

### Marlin / VLM / existing analysis

Marlin can infer:

- semantic events and visual actions
- scene descriptions
- movement/action peaks
- some A-roll/B-roll hints when paired with transcript/context
- whether a segment visually feels like an insert, cutaway, texture, or action shot

Marlin should not be the source for:

- codec, bit depth, color space, timecode, reel/card, lens facts
- LUFS, RMS, peak level, channel layout
- exact scene/shot/take unless visible slate or filename/user context supports it

Existing `visual_quality`, `visual_appraisal`, `peak_analysis`, tags, summary, transcript, and `role_guess` should remain part of the search text and ranking signals.

### User context interview

Ask the user or import notes for fields that production tools cannot reliably infer:

- scene/shot/take conventions
- circle takes and best takes
- whether ambiguous talking footage is A-roll or B-roll
- intentional look, reference grade, or white-balance exceptions
- room-tone preferences
- rights/privacy constraints
- camera/card naming conventions

Every user-provided fact should carry `source: "operator_declared"` or equivalent provenance. It should override model inference but not overwrite file technical metadata.

## 9. Implementation Priority And Acceptance

Recommended rollout:

1. Index technical facts already present in `assets.json` and `source_media_manifest`.
2. Extend ffprobe persistence into optional `asset_technical_metadata`.
3. Add segment audio profile using deterministic `ffmpeg` analysis.
4. Add segment color profile using sampled frames.
5. Add deterministic filename/folder logging parser with configurable patterns.
6. Add optional MediaInfo/ExifTool enrichers.
7. Add user/operator note import or context-interview mapping.

Acceptance criteria for a first practical implementation:

- Existing projects without the new sidecars still build and search.
- `footage.db` status includes source hashes for any new metadata sidecars.
- Missing MediaInfo, ExifTool, or original media produces warnings, not failed analysis, unless a user explicitly requires production metadata.
- A search can filter for dialogue-safe A-roll, warm/normal-exposure B-roll, VFR footage, and unusable audio without changing `segments.json`.
- XML/EDL export can report source locator, source timecode basis, reel/card when known, and relink hash evidence.

## 10. Self-review

Rubric score after revision: 94/100.

Remaining deductions:

- Exact extractor command lines and output normalization schemas should be finalized in implementation docs.
- The optional sidecar names are proposed, not yet integrated with the existing artifact state machine.
- Lens metadata depends heavily on camera/vendor support and may remain sparse.

Final check:

- Purpose and success conditions: defined.
- Scope boundary: derived metadata for AI rough-cut editing, not a full NLE database.
- Current extraction gaps: mapped against `ffprobe.ts`, derivative generation, DB design, and segment schema.
- Practical DB additions: scoped to asset technical facts, segment color/audio profiles, and logging metadata.
- Extraction sources: split across ffprobe, MediaInfo, ExifTool, dedicated analysis, Marlin/VLM, and user context.
- Risk handling: missing tools and missing metadata degrade with warnings.
