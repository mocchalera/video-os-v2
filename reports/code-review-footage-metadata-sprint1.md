# Code Review: Footage Metadata Sprint 1

## Summary

Sprint 1 compiles and the targeted tests pass, but the implementation is not yet aligned with the unified metadata design. The main risk is contract drift: the new tables, field names, enum values, and filter surface use a narrower local vocabulary than `docs/design-footage-metadata-unified.md`, so callers built against the design examples will not be able to query the data reliably.

The extraction path is also more inferential than the design allows. Ambiguous Marlin text defaults to concrete `static` / `stable` / `medium` labels, scene/shot/take is guessed from camera timestamps, and audio level extraction exists as a helper but is not wired into the builder. This creates both false positives and missing Sprint 1 functionality, especially for dialogue-free B-roll, circle takes, and metadata FTS queries.

Validation run:

- `npx vitest run tests/footage-metadata-extractor.test.ts tests/footage-db.test.ts` - passed, 14 tests.
- `npx tsc --noEmit` - passed.

## Issues Found

1. `runtime/artifacts/footage-db-builder.ts:179`, `runtime/artifacts/footage-db-builder.ts:222`, `runtime/artifacts/footage-db-builder.ts:243`, `runtime/artifacts/footage-db-builder.ts:256`, `runtime/artifacts/footage-db-builder.ts:413` - **High** - The DDL does not match Section 4 of the unified design. Examples: `asset_technical` is not `asset_technical_metadata` and omits container/raw-rate/rotation/audio-stream/evidence fields; `segment_visual_profile` stores `camera_motion`, `motion_direction`, `motion_speed`, and `stability` instead of `camera_motion_description`, `camera_motion_type`, `camera_motion_direction`, `camera_stability`, confidence/evidence fields, and the rest of the visual profile slots; `segment_audio_profile` lacks `audio_role`, `peak_dbfs`, `rms_dbfs`, `integrated_lufs`, silence windows, noise flags, confidence, and evidence; `segment_logging` is not `segment_logging_profile` and lacks `camera_id`, `card_id`, `circle_take`, `best_take`, `custom_tags_json`, `operator_notes`, `source`, confidence, and evidence. This will break downstream code that follows the design DDL.

2. `runtime/artifacts/footage-metadata-extractor.ts:28`, `runtime/artifacts/footage-metadata-extractor.ts:39`, `runtime/artifacts/footage-metadata-extractor.ts:51`, `runtime/artifacts/footage-metadata-extractor.ts:70`, `runtime/artifacts/footage-db-builder.ts:224` - **High** - The extractor and CHECK constraints use rejected/non-unified vocabularies. The design normalizes motion to `pan`, `tilt`, `push_in`, `pull_out`, etc. with direction values like `ltr`, `rtl`, `toward_camera`, and `away_camera`; the code stores values such as `pan_right`, `dolly_in`, `drone`, `right`, `forward`, `full`, `closeup`, and `medium_closeup`. Design-shaped filters such as `camera_motion_type: "pan"` or `shot_scale: "medium_close"` will not match these rows.

3. `runtime/artifacts/footage-metadata-extractor.ts:57`, `runtime/artifacts/footage-metadata-extractor.ts:67`, `runtime/artifacts/footage-metadata-extractor.ts:80`, `runtime/artifacts/footage-metadata-extractor.ts:130` - **High** - Ambiguous descriptions are over-classified instead of left `unknown`. `extractCameraMotion` returns `static` for every text with no explicit motion cue, `extractStability` returns `stable` by default, and `extractShotScale` returns `medium` by default. The design explicitly says Marlin phrase parsing is evidence, not geometry, and to prefer `unknown` over overconfident labels. The `follows?` pattern also classifies subject-action prose like "the child follows the path" as a camera tracking shot.

4. `runtime/artifacts/footage-metadata-extractor.ts:104`, `runtime/artifacts/footage-metadata-extractor.ts:108`, `runtime/artifacts/footage-db-builder.ts:1155`, `runtime/artifacts/footage-db-builder.ts:1165` - **High** - Scene/shot/take is guessed from filenames and timestamps without a configured parser or user annotation source. For `A001_20260619_143015_C0007.mov`, the code stores scene `20260619` and shot `143015`, but the design says logging fields come from user annotations, imported logs, or configured filename parsers, and otherwise stay null. It also stores numbers, losing useful leading zeros like `"03"`.

5. `runtime/artifacts/footage-db-builder.ts:510`, `runtime/artifacts/footage-db-builder.ts:530`, `runtime/artifacts/footage-db-builder.ts:1155` - **High** - The optional `03_analysis/footage_user_annotations.json` sidecar is not loaded, so `circle_take`, `best_take`, custom tags, operator notes, camera/card IDs, and annotated scene/shot/take cannot be populated. This misses the Sprint 1 acceptance case for circle takes when data exists.

6. `runtime/artifacts/footage-db-builder.ts:1140`, `runtime/artifacts/footage-db-builder.ts:1149`, `runtime/artifacts/footage-metadata-extractor.ts:117`, `runtime/artifacts/footage-metadata-extractor.ts:186` - **High** - Audio level extraction is not wired into the builder. Every row currently stores null `peak_db`, `rms_db`, and `loudness_lufs`, and no silence metrics are computed. The helper uses `volumedetect` but tries to parse LUFS from `I:`, which that filter does not emit; the design calls for segment-range `astats` / `ebur128` / `silencedetect` metrics and warnings when media or ffmpeg analysis is unavailable.

7. `runtime/tools/footage-search.ts:23`, `runtime/tools/footage-search.ts:567`, `runtime/tools/footage-search.ts:575`, `runtime/tools/footage-search.ts:591` - **High** - The search filter surface does not implement the Sprint 1 contract. It lacks technical filters (`video_codec`, `frame_rate_mode`, `min_width`, etc.), design-named visual filters (`camera_motion_type`, `camera_stability`, arrays), audio filters (`audio_role`, music/ambient, level and silence ranges), production filters (`scene_number`, `take_number`, `circle_take`, `custom_tags_any`), and `min_metadata_confidence`. SQL parameterization for the implemented filters is safe, and missing metadata tables are handled, but most design filters cannot be expressed.

8. `runtime/artifacts/footage-db-builder.ts:413`, `runtime/tools/footage-search.ts:621`, `runtime/tools/footage-search.ts:1082` - **Medium** - Metadata FTS is populated but not queried as a dedicated FTS table. The design adds `segment_metadata_fts(cinematography, technical, audio, logging)`, while the code creates `metadata_fts(camera_motion, shot_scale, dominant_subject_position, user_notes)` and `ftsScores` still searches only `segments_fts`. Some metadata terms are copied into `segments_fts.quality_labels`, but the new metadata FTS table itself is effectively unused.

9. `runtime/artifacts/footage-db-builder.ts:1165`, `runtime/artifacts/footage-db-builder.ts:1293` - **Medium** - The `unusable` classifier is too coarse for practical use. `all scores < 0.3` marks only uniformly bad shots as unusable; one missing or slightly higher score makes the segment `fully_usable`, and `partially_usable` is never produced. It also ignores explicit quality flags such as blur, overexposure, shake, clipping, or bad audio.

10. `runtime/artifacts/footage-metadata-extractor.ts:83`, `runtime/artifacts/footage-metadata-extractor.ts:143`, `tests/footage-metadata-extractor.test.ts:41` - **Medium** - Filename coverage is narrow. The tests cover one explicit `S001_S002_T084` pattern and one timestamp-plus-`C0007` pattern, but there is no GoPro (`GOPR/GH/GX/GP...`) or DJI (`DJI_...`) coverage, no Blackmagic patterns without a `20YYYYMMDD` timestamp, no card/reel extraction, and no explicit behavior for "do not parse without configured pattern."

## Test Gaps

- No schema-conformance test checks the unified DDL table names, columns, CHECK enums, or indexes.
- No tests assert spec vocabulary normalization: `pan` + `ltr`, `push_in` + `toward_camera`, `medium_close`, `close`, `unknown`, etc.
- No negative extraction tests for ambiguous Marlin descriptions, subject movement false positives, "wide angle" lens wording, or static subject/action prose.
- No annotation sidecar fixture for scene/shot/take, `circle_take`, `best_take`, `custom_tags`, `operator_notes`, `camera_id`, or `card_id`.
- No ffmpeg audio fixture for peak/RMS/LUFS and silence windows; the current tests only assert null audio levels.
- No search tests for design-level filters: arrays, audio role, level ranges, silence ranges, scene/take/circle/custom tags, technical metadata, or `min_metadata_confidence`.
- No test proves `metadata_fts` is actually queried; current coverage only counts rows.
- No edge tests for older DBs with some, but not all, metadata tables present.

## Recommendations

1. Align the schema first. Use the Section 4 table names and column names, or explicitly revise the unified design before adding more code on top of the current names.

2. Normalize extractor outputs to the unified enums. Store `camera_motion_type` separately from `camera_motion_direction`, map dolly terms to `push_in` / `pull_out`, map left/right prose to screen-direction vocabulary, and make `unknown` the default for non-explicit cues.

3. Gate logging metadata behind explicit annotation/configuration. Add `footage_user_annotations.json` import and leave scene/shot/take null unless a configured parser or sidecar provides it. Preserve values as strings.

4. Wire real audio analysis or fail open with warnings. If source media is unavailable, keep null level/silence fields and record build warnings; if available, run segment-range `astats`, `ebur128`, and `silencedetect`.

5. Expand search to the design filter API after the schema is stable. Use parameterized clauses for structured fields, TypeScript post-filtering for JSON arrays, and table-missing warnings for metadata-only filters.

6. Either query `segment_metadata_fts` directly or remove the unused table until search needs it. If kept, use the design columns and add a test where a metadata-only term is found through metadata FTS.

7. Replace the current `unusable` heuristic with a separate derived-quality policy, or keep it out of Sprint 1 logging metadata. At minimum, support `partially_usable`, quality flags, and confidence/evidence.

8. Add tests that assert the design contract, not just the current implementation outputs, before iterating on keyword coverage.
