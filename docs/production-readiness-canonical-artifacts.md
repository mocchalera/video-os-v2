# Production Readiness Canonical Artifacts

- Status: Draft v2
- Created: 2026-04-26
- Revised: 2026-04-26
- Scope: docs-only design extension
- Non-goal: implementation code, schema files, package files, or existing docs changes

## 1. Current Strengths And Blind Spots

Video OS v2 already has a strong artifact-driven spine:

- `creative_brief.yaml`, `unresolved_blockers.yaml`, `selects_candidates.yaml`, `edit_blueprint.yaml`, `timeline.json`, `review_report.yaml`, and `project_state.yaml` are durable truth.
- VLM peak detection, STT, audio events, BGM analysis, and deterministic compile are separated from agent reasoning.
- The compiler is deterministic and must not call providers. It consumes already-materialized planning artifacts and emits `timeline.json`.
- Existing gates are explicit: unresolved blockers block compilation, fatal review issues block final render, and `project_state.yaml` persists resume state.
- `timeline.json.clip.metadata` and `marker.metadata` are intentional extension points, while most other canonical artifacts should remain closed-schema.

The production-readiness gap is not raw media understanding alone. The system does not yet persist enough about the editor's operating context:

- source media provenance, fingerprinting, rights/privacy declarations, timecode, and sync facts are not a first-class root.
- audio story intent is scattered across transcripts, audio events, BGM analysis, music policy, and timeline audio tracks.
- continuity is implicit in segments, candidate order, visual tags, and reviewer notes, but not available as a first-class graph.
- user/editor preferences exist in brief fields, `STYLE.md`, human notes, and accepted edits, but are not normalized into durable memory.
- release safety is split across review, QA, package manifest, rights assumptions, and source-of-truth decisions.
- analysis coverage is not a first-class gate input, so partial analysis can look complete unless a human inspects details.

Production readiness requires canonical artifacts that answer: what source media exists, what was heard, what must remain continuous, what this editor tends to prefer, whether this can be released, and whether analysis is complete enough to trust.

## 2. Canonical Artifact Tiers

### Required MVP

The MVP is now six artifacts. `source_media_manifest.json` is a foundation artifact, not a later enhancement, because coverage, rights/privacy, stale source detection, package provenance, and sync quality all depend on it.

| Artifact | Kind | Proposed path | Primary owner | MVP role |
| --- | --- | --- | --- | --- |
| `source_media_manifest.json` | canonical inventory | `projects/<id>/02_media/source_media_manifest.json` | `init-project` + analysis ingest | source identity, fingerprints, rights/privacy declarations, sync metadata, stale detection |
| `analysis_coverage_report.json` | canonical gate report | `projects/<id>/03_analysis/analysis_coverage_report.json` | `scripts/analyze.ts` / analysis pipeline | lane readiness, missing inputs, override scope |
| `audio_story_graph.json` | canonical graph | `projects/<id>/03_analysis/audio_story_graph.json` | analysis runtime + `/blueprint` projection | audio/story evidence projection |
| `continuity_graph.json` | canonical graph | `projects/<id>/03_analysis/continuity_graph.json` | analysis runtime + `/triage` projection | visual/time/entity continuity projection |
| `editorial_preference_memory.jsonl` | canonical append log | `projects/<id>/00_project/editorial_preference_memory.jsonl` | operator/runtime state command | explicit human preference memory |
| `release_safety_report.yaml` | canonical report | `projects/<id>/07_package/release_safety_report.yaml` | `/package` or `/render` preflight | report-only until P4, enforcement after migration |

MVP dependency rule:

- `analysis_coverage_report.json`, `audio_story_graph.json`, `continuity_graph.json`, and `release_safety_report.yaml` must reference `source_media_manifest.json` by hash whenever they cite source assets.
- `audio_story_graph.json` must not create utterance, music, or ambient nodes for a source asset that is absent from the manifest.
- `continuity_graph.json` must not confirm entity continuity across assets unless each asset has manifest-backed fingerprints and capture metadata.
- `analysis_coverage_report.json` cannot be `ready` unless the `source_manifest` lane is `ready`.
- `release_safety_report.yaml` reads manifest rights/privacy/source freshness as input; it does not replace dedicated rights/privacy registers when those land.

### Next Tier

These should land after MVP foundation, coverage, and graph consumers exist.

| Artifact | Kind | Proposed path | Reason |
| --- | --- | --- | --- |
| `delivery_profiles/*.yaml` | canonical delivery contracts | `projects/<id>/07_package/delivery_profiles/<profile>.yaml` | required to make platform/output QA deterministic across YouTube, Shorts, Instagram, internal review, and client handoff |
| `caption_plan.json` | canonical caption plan or explicit mapping | `projects/<id>/06_review/caption_plan.json` | maps audio story node refs to speech captions, authored overlays, approval, and render timing |
| `rights_license_register.yaml` | canonical declaration register | `projects/<id>/07_package/rights_license_register.yaml` | separates operator declarations from machine checks for music, stock, SFX, fonts, generated assets, and user media |
| `privacy_face_review_report.yaml` | canonical release input | `projects/<id>/07_package/privacy_face_review_report.yaml` | owns face/person release risk, blur/anonymization requirements, and human confirmation |
| `sync_quality_report.json` | canonical technical report | `projects/<id>/03_analysis/sync_quality_report.json` | tracks A/V drift, transcript alignment, caption alignment, multicam offsets, and frame accuracy |
| confidence calibration fields | schema extension | embedded in analysis artifacts and graph nodes | required to compare provider confidence against empirical quality |
| `confidence_calibration_report.json` | canonical eval report | `projects/<id>/08_eval/confidence_calibration_report.json` | required before confidence becomes an automated gate |

### Later Tier

These are important but should not block the first production-readiness pass.

| Artifact | Kind | Proposed path | Reason |
| --- | --- | --- | --- |
| `segment_search_index` | derived index + manifest | `projects/<id>/03_analysis/search/segment_search_index.json` | enables fast multimodal search but must be rebuildable |
| vector store shards | derived | `projects/<id>/03_analysis/search/*.vectors` | provider-dependent; do not make source of truth |
| `identity_alias_register.yaml` | canonical mapping | `projects/<id>/07_package/identity_alias_register.yaml` | maps speaker labels, face clusters, caption names, and anonymized names |
| `release_forms_register.yaml` | canonical declaration register | `projects/<id>/07_package/release_forms_register.yaml` | tracks person/place/minor/customer-case consent status, scope, expiry, and evidence path |
| `emotion_tone_map.json` | canonical or planning support | `projects/<id>/03_analysis/emotion_tone_map.json` | maps segment/audio/story node tone risks and intended emotional curve |
| `voice_quality_report.json` | canonical technical report | `projects/<id>/03_analysis/voice_quality_report.json` | isolates clipping, noise, distant voice, speaker consistency, and diarization risk from story semantics |
| `sfx_jingle_cues.json` | canonical cue plan | `projects/<id>/05_blueprint/sfx_jingle_cues.json` | covers non-BGM SFX/jingles, rights, timing, ducking, and provenance |
| `artifact_migration_log.jsonl` | canonical append log | `projects/<id>/00_project/artifact_migration_log.jsonl` | tracks schema upgrades, JSONL compaction, artifact redaction, and takedown |
| `revenue_distribution.yaml` | optional commercial declaration | `projects/<id>/07_package/revenue_distribution.yaml` | only relevant for commercial/public releases with revenue split obligations |

## 3. Versioning, Hash, And Provenance Policy

All six MVP artifacts must use the same semantic policy even when existing M4 package artifacts use slightly different field sets.

| Field | Meaning | Required on new MVP artifacts | Rule |
| --- | --- | --- | --- |
| `version` | schema contract version | yes | semver string, e.g. `1.0.0`; increment minor for additive fields, major for breaking schema changes |
| `artifact_version` | generated analysis/projection generation identifier | yes | stable generation id such as `analysis-v3` or `projection-v2`; changes when upstream corpus or projection logic changes |
| `base_timeline_version` | timeline binding | only timeline-bound artifacts | required for `release_safety_report.yaml`; optional/absent for source/analysis artifacts before a timeline exists |
| `provenance.inputs[].hash` | direct input artifact hashes | yes | SHA-256 of deterministic normalized JSON/YAML or raw file content for source media |
| `provenance.hash_policy` | hash calculation declaration | yes | states canonicalization mode, excluded volatile fields, and algorithm |
| `project_state.artifact_hashes.*` | latest known artifact hash refs | future schema extension | stores the latest accepted hash for resume/gate checks |

Hash policy:

- JSON artifacts are hashed after deterministic key ordering and UTF-8 normalization.
- YAML artifacts are converted to deterministic normalized JSON before hashing.
- JSONL artifacts are hashed as ordered records after validating each line; compaction must write an `artifact_migration_log.jsonl` entry.
- Raw media file hashes use content SHA-256 or a documented fingerprint when full hashing is not practical.
- Volatile fields such as `created_at` may be excluded only if the schema declares `provenance.hash_policy.excluded_fields`.
- `artifact_hashes` in `project_state.yaml` should store `sha256:<hex>` values and never human-readable status.

Compatibility with existing M4 artifacts:

- `caption_approval.json` and `music_cues.json` may keep `version` and `base_timeline_version` without `artifact_version`; v2 does not require retroactive schema changes.
- New MVP artifacts must include `artifact_version`.
- Package-plane artifacts that aggregate existing M4 artifacts should cite their input hashes rather than copying fields.

## 4. State Machine And Gate Vocabulary

v2 does not add new top-level project states. Existing state names remain the coarse workflow checkpoints. Fine-grained readiness is represented by `project_state.gates.analysis_gate`, `planning_gate`, `compile_gate`, `review_gate`, and `packaging_gate`.

### State And Gate Responsibilities

| Concept | Responsibility | Not responsible for |
| --- | --- | --- |
| `media_analyzed` state | raw ingest and baseline analysis artifacts exist: assets, segments, transcripts when applicable, contact sheets/filmstrips, source manifest, and coverage report | proving that planning graphs are complete for every workflow |
| `analysis_gate` | whether required raw analysis lanes are `ready`, `partial_override`, or `blocked` | editorial selection, continuity ordering, package release |
| `planning_gate` | whether planning-specific evidence is usable: audio story graph, continuity graph, preference memory, and graph projection readiness | raw ingest completeness or final render safety |
| `compile_gate` | whether `selects_candidates.yaml`, `edit_blueprint.yaml`, and unresolved blockers permit deterministic compile | package/release safety |
| `review_gate` | whether fatal editorial review issues remain | source rights, delivery profile, package QA |
| `packaging_gate` | whether package/release checks pass after P4 enforcement | rough-cut editorial quality |

### Artifact-To-Gate Matrix

| Artifact | `media_analyzed` | `analysis_gate` | `planning_gate` | `compile_gate` | `review_gate` | `packaging_gate` |
| --- | --- | --- | --- | --- | --- | --- |
| `source_media_manifest.json` | required | required lane `source_manifest` | referenced by graphs | stale used sources can block | referenced for source facts | required input, stale/missing used sources block after P4 |
| `analysis_coverage_report.json` | required | primary controller | exposes graph lane readiness | blocks compile only through explicit gate status | advisory | advisory except package evidence freshness after P4 |
| `audio_story_graph.json` | not required for state transition | lane may be ready/partial/skipped | required for dialogue/music-driven planning unless override | only via projected refs in planning artifacts | review may cite missing setup/payoff | caption/music/package refs may cite it |
| `continuity_graph.json` | not required for state transition | lane may be ready/partial/skipped | required for multi-asset chronological planning unless override | only via projected refs in planning artifacts | review may cite continuity break | privacy/identity checks reference only refs |
| `editorial_preference_memory.jsonl` | optional from init | not controlled | consumed hash/offset controls stale preference checks | conflicting required preferences create blockers | informs accepted style overrides | delivery preferences apply only through delivery profile |
| `release_safety_report.yaml` | absent-ok | not controlled | not controlled | not controlled before P4 | reads review status | report-only before P4, enforcing after migration |

### Partial And Override Transitions

`analysis_gate.partial` is allowed when all are true:

- at least one required lane is `partial`, `skipped`, or `failed`;
- `analysis_coverage_report.summary.status == partial_override`;
- `project_state.analysis_override.status == active`;
- override `scope` names the missing lanes, affected asset IDs, and allowed consumers;
- override has `approved_by`, `approved_at`, `reason`, and `expires_at` or `applies_to_artifact_hash`.

`analysis_override.active` may be created only by an explicit human/operator command. It cannot be inferred from missing data. It must be cleared or renewed when any of these changes:

- `source_media_manifest.json` hash changes;
- a previously missing lane becomes ready;
- `selects_candidates.yaml`, `edit_blueprint.yaml`, or `timeline.json` consumes the overridden lane;
- the override expiry is reached.

`planning_gate` may be `partial_override` only when graph-specific missing data is bounded to the selected workflow. Example: a no-dialogue music montage may skip diarization and still pass planning if audio story graph declares `dialogue_lane: skipped` and the coverage report records consumer impact.

## 5. MVP Artifact Contracts

### `source_media_manifest.json`

Purpose:

- Bind source files to stable asset IDs, file fingerprints, source locator, capture metadata, ingest status, rights/privacy declarations, and analysis eligibility.
- Provide the root reference for coverage, graph provenance, release safety, package provenance, stale source detection, and sync quality.

Producer:

- Primary: `init-project` when `--source-dir` or explicit media inputs are provided.
- Update path: `scripts/analyze.ts` before `assets.json` creation; later ingest commands may append/update entries through controlled manifest writes.
- No downstream graph builder may invent a source asset outside this manifest.

Consumers:

- `analysis_coverage_report.json`: requires `source_manifest` lane before `summary.status == ready`.
- `audio_story_graph.json`: validates every utterance, audio event, BGM, ambient, and source ref.
- `continuity_graph.json`: validates each entity/segment source ref and capture/timecode basis.
- `release_safety_report.yaml`: reads source freshness, rights/privacy declarations, and used-source completeness.
- `package_manifest.json`: cites package provenance and source-of-truth hashes.
- `sync_quality_report.json`: uses capture/timecode/audio metadata as baseline.

State-machine position:

- Required before `media_analyzed`.
- Controls `analysis_gate` through the `source_manifest` lane.
- Missing or stale sources used by the current timeline block `packaging_gate` after P4 enforcement.

Schema strictness:

- Closed root object with `additionalProperties: false`.
- Required root fields: `version`, `project_id`, `artifact_version`, `created_at`, `source_root`, `items`, `provenance`.
- Required item fields: `asset_id`, `source_locator`, `filename`, `content_hash` or `fingerprint`, `size_bytes`, `mtime`, `media_kind`, `ingest_status`, `rights_status`, `privacy_status`, `analysis_policy_ref`.
- Frame/sync candidate fields: `capture_started_at`, `capture_timezone`, `timecode_start`, `timecode_format`, `sample_rate`, `duration_us`, `frame_rate_mode`, `rotation`, `audio_video_offset_ms`, `clock_source`.
- Rights/privacy fields are operator declarations unless a dedicated rights/privacy artifact later owns them.

Failure handling:

- Missing source file: mark item `ingest_status: missing`; coverage becomes blocked if the asset is required for current analysis.
- Hash mismatch: mark item `ingest_status: stale`; downstream artifacts citing the old hash become stale.
- Unknown rights/privacy: allowed during analysis, but release safety records `blocker` for public/external delivery and can become `fatal` after P4 enforcement.
- Ambiguous capture timezone/timecode: analysis may proceed, but sync-sensitive workflows must record `sync_basis: inferred` and planning may require override.

### `analysis_coverage_report.json`

Purpose:

- Make analysis completeness machine-readable so gates can distinguish ready, partial, skipped, failed, and waived analysis lanes.
- Summarize coverage by asset, segment, transcript, diarization, VLM tags, peak analysis, audio events, audio story graph, continuity graph, contact sheets, filmstrips, embeddings, source manifest, and sync quality.

Producer:

- Primary: `scripts/analyze.ts` and analysis pipeline stages.
- Updated after each analysis stage, not only at the end.
- Must always cite the current `source_media_manifest.json` hash.

Consumers:

- `status`: explains missing analysis and what can run next.
- `/triage`: refuses to create candidates from missing analysis lanes unless override is explicit.
- `/blueprint`: warns or blocks when story/continuity evidence is too incomplete for the requested autonomy mode.
- `project_state.yaml`: stores coverage status, gate status, artifact hash, and analysis artifact version.

State-machine position:

- Created during `intent_locked -> media_analyzed`.
- Required before `media_analyzed`.
- Owns `analysis_gate`; informs `planning_gate`.

Schema strictness:

- Closed JSON schema.
- Required root fields: `version`, `project_id`, `artifact_version`, `created_at`, `source_media_manifest_hash`, `summary`, `lanes`, `assets`, `blockers`, `overrides`, `provenance`.
- Lane IDs are bounded: `source_manifest`, `ffprobe`, `segments`, `contact_sheets`, `filmstrips`, `stt`, `diarization`, `vlm_tags`, `vlm_peaks`, `audio_events`, `bgm_analysis`, `audio_story_graph`, `continuity_graph`, `embeddings`, `sync_quality`.
- Lane status enum: `pending`, `ready`, `partial`, `skipped`, `failed`, `waived`.
- `summary.status` enum: `ready`, `partial_override`, `blocked`.

Failure handling:

- Any required lane with `failed` or `pending` sets `summary.status: blocked`.
- Optional lanes may be `skipped` only when `reason` and `consumer_impact` are present.
- Human override writes `project_state.yaml.analysis_override` and the report records `waiver_id`; the report itself does not silently mark missing lanes ready.
- Coverage cannot be `ready` while `source_manifest` is missing or stale.

### `audio_story_graph.json`

Purpose:

- Convert audio evidence into a story graph that downstream planning can use without rereading transcripts, waveform images, BGM beat lists, and audio events.
- Represent utterances, speaker turns, silence, laughter, applause, music onset/end, impact, ambient shifts, emotional lift/drop, and BGM sections as linked nodes.
- Make audio continuity and story timing available to `/blueprint`, compiler trim policy, roughcut review, caption planning, and music cue planning.

Producer:

- Primary: analysis pipeline after STT, diarization, `audio_events.json`, and optional `bgm-analysis.json` are available.
- Secondary projection: `/blueprint` may attach story roles such as `hook`, `setup`, `experience`, and `closing`, but must not mutate raw audio facts.

Consumers:

- `/blueprint`: maps audio nodes to beat story roles and dialogue/music policy.
- `/triage`: uses audio salience to score candidate windows.
- compiler: reads only materialized fields in `selects_candidates.yaml` / `edit_blueprint.yaml`; it should not query this graph directly in MVP.
- `/review`: detects dropped setup/payoff audio, awkward silence, or missing reaction after important utterance.
- `/caption` and `/package`: use node refs for caption source and music cue consistency.

State-machine position:

- Not a condition for entering `media_analyzed`.
- Required by `planning_gate` for dialogue/music-driven projects unless `analysis_override.active` scopes missing audio lanes.
- Its readiness is represented as the `audio_story_graph` lane in `analysis_coverage_report.json`.

Schema strictness:

- Closed root object with `additionalProperties: false`.
- Required root fields: `version`, `project_id`, `artifact_version`, `created_at`, `source_media_manifest_hash`, `inputs`, `nodes`, `edges`, `coverage`, `provenance`.
- Node IDs are artifact-local unless explicitly declared cross-artifact. Prefixes: `ASG_` for graph-owned nodes, `UTTREF_` for transcript refs, `SPKREF_` for speaker refs, `AEREF_` for audio event refs, `BGMREF_` for music section refs.
- Edges use explicit types: `precedes`, `responds_to`, `overlaps`, `supports_beat`, `contrasts_with`, `music_under`, `silence_after`, `payoff_for`.
- Confidence records should map to existing `analysis-common` confidence/provenance shapes when those schemas are reused.

Failure handling:

- If STT or diarization fails, emit `status: partial` with missing lanes in `coverage.missing_inputs`; do not invent dialogue nodes.
- If audio events fail but STT succeeds, emit utterance graph and mark `audio_event_lane: failed`.
- If the project is music-only or no-dialogue, emit a valid graph with `dialogue_lane: skipped` and music/ambient nodes.
- `compile_gate` remains open only if `/triage` and `/blueprint` can materialize required audio decisions without unresolved blockers.

### `continuity_graph.json`

Purpose:

- Persist continuity constraints that an editor normally holds mentally: subject identity, location continuity, chronology, screen direction, action continuation, wardrobe/prop continuity, visual motif recurrence, and intentional discontinuity.
- Provide a machine-readable basis for avoiding incoherent jumps and for justifying deliberate axis/time breaks.

Producer:

- Primary: analysis pipeline after `source_media_manifest.json`, `assets.json`, `segments.json`, contact sheets, filmstrips, and VLM tags.
- Secondary: `/triage` adds candidate-level continuity clusters and risk labels.
- Human/reviewer feedback should create graph patch entries in a later `*_graph_patch.jsonl` workflow, not ad hoc direct graph edits.

Consumers:

- `/triage`: avoids selecting visually redundant or continuity-breaking candidates unless requested.
- `/blueprint`: chooses chronological vs editorial order and marks deliberate discontinuities.
- compiler: consumes only projected `candidate_ref`, `timeline_order`, transition skill, and continuity risk fields in planning artifacts.
- `/review`: flags unintended continuity breaks in `review_report.yaml`.
- Premiere/round-trip diff: uses graph refs to explain human reorders.

State-machine position:

- Not a condition for entering `media_analyzed`.
- Required by `planning_gate` for projects with more than one source asset or with `timeline_order: chronological`, unless override is active.
- Updated only by re-analysis or explicit continuity correction workflow; edits invalidate downstream `selects_candidates.yaml`, `edit_blueprint.yaml`, and `timeline.json`.

Schema strictness:

- Closed root object.
- Required root fields: `version`, `project_id`, `artifact_version`, `created_at`, `source_media_manifest_hash`, `entities`, `segments`, `edges`, `risks`, `provenance`.
- Entity IDs use stable prefixes: `ENT_SUBJECT_`, `ENT_LOCATION_`, `ENT_PROP_`, `ENT_MOTIF_`, `ENT_ACTION_`.
- Edge types are bounded enums: `same_subject`, `same_location`, `chronologically_before`, `action_continues`, `screen_direction_consistent`, `screen_direction_break`, `visual_match`, `visual_contrast`, `duplicate_semantic_content`.
- Anonymous subject clusters are editing-continuity hypotheses, not release identity confirmations.

Failure handling:

- Low-confidence face/person matches must be `hypothesis`, not confirmed identity.
- Privacy-sensitive detections must be redacted or represented as anonymous entities until privacy responsibility is decided.
- Missing continuity graph blocks automatic chronological compilation for multi-asset projects unless `analysis_override` records scope and reason.

### `editorial_preference_memory.jsonl`

Purpose:

- Persist project-specific editor preferences and learned decisions as an append-only log rather than burying them in chat history.
- Record preferences such as pacing bias, chronological preference, transition taste, tolerated repetition, BGM loudness taste, caption density, human override rationale, and accepted/rejected review patches.

Producer:

- Primary: operator-facing state/preference command.
- Secondary: `/blueprint`, `/review`, `/import-premiere`, and `/package` may append entries when a human explicitly accepts or rejects a decision.
- No background agent may silently write preference memory.

Consumers:

- `/intent`: preloads known project preferences before asking questions.
- `/blueprint`: resolves `pacing.confirmed_preferences`, profile/policy choices, and quality targets.
- `/review`: distinguishes a true issue from an accepted house style.
- `/package`: applies delivery preferences only if they are compatible with `delivery_profiles/*.yaml`.

State-machine position:

- Exists from project initialization onward.
- Append-only across all states.
- Downstream artifacts store the consumed preference log offset and hash, so stale preferences can be detected.

Schema strictness:

- JSON Lines, one strict JSON object per line.
- Required fields per entry: `version`, `project_id`, `entry_id`, `created_at`, `actor`, `source_event`, `preference_type`, `value`, `scope`, `confidence`, `status`.
- `status` enum: `active`, `superseded`, `rejected`, `expired`, `redacted`.
- `scope` enum: `project`, `series`, `profile`, `delivery`, `temporary`.
- Because JSONL is append-only, supersession is represented by a new entry with `supersedes_entry_id`.

Failure handling:

- Malformed lines are quarantined with line number and byte offset; loader returns last-known-good offset unless the malformed entry is within the consumed range required by the caller.
- Preference loading failure blocks `/blueprint` only when the current `edit_blueprint.yaml` declares dependency on the affected preference log hash.
- Conflicting active preferences create an unresolved blocker unless one entry has explicit human priority.
- Corrections, privacy redactions, compaction, and schema migrations are tracked through `artifact_migration_log.jsonl` when that later-tier artifact exists; before that, a scoped redaction entry must be appended to the same log.

### `release_safety_report.yaml`

Purpose:

- Provide a single release report that combines review fatality, technical QA, source-of-truth decision, delivery requirements, rights/privacy declarations, caption/audio deliverables, package completeness, and known waivers.
- Make "can this be rendered or shipped" separate from "does this rough cut look good."
- Aggregate existing M4 package/caption/music artifacts without taking ownership of their source-of-truth fields.

Producer:

- Primary: `/package` or `/render` preflight.
- Inputs: `project_state.yaml`, `timeline.json`, `review_report.yaml`, `caption_approval.json`, `music_cues.json`, `package_manifest.json`, `package-qa-report.json`, `delivery_profiles/*.yaml`, `source_media_manifest.json`, `handoff_resolution`, rights/privacy notes/registers, and human approval records.

Consumers:

- `/render`: before P4, displays warnings and report-only blockers; after P4 enforcement, refuses release render when enforcement rules fail.
- `/package`: before P4, writes package report without blocking existing workflows; after P4, refuses package finalization when enforce-mode checks fail.
- `status`: displays release blockers with exact artifact refs.
- Human operator: approves waivers with named responsibility.

State-machine position:

- First useful after `critique_ready`.
- MVP exists as report-only and absent-ok for P1-P3.
- Required for `approved -> packaged` only after P4 enforcement migration is complete.
- Updated whenever review, timeline, delivery profile, QA report, package manifest, source media manifest, caption approval, music cues, or handoff resolution changes.

Schema strictness:

- YAML with a closed schema.
- Required root fields: `version`, `project_id`, `created_at`, `base_timeline_version`, `source_of_truth`, `mode`, `summary`, `checks`, `waivers`, `provenance`.
- `mode` enum: `dry_run`, `report_only`, `enforce`.
- `summary.status` enum: `pass`, `blocked`, `pass_with_waiver`, `not_evaluated`.
- Check severity enum: `info`, `warning`, `blocker`, `fatal`.
- Check categories: `editorial_review`, `schema_validation`, `technical_qa`, `delivery_profile`, `rights`, `privacy`, `source_of_truth`, `caption_audio`, `music_audio`, `package_completeness`, `source_manifest`.

Failure handling:

- In `dry_run`, missing inputs produce `not_evaluated` or `warning`; no gate is blocked.
- In `report_only`, missing required release inputs produce `blocker` or `fatal` checks, but do not block `approved -> packaged`.
- In `enforce`, `summary.status == blocked` or any unwaived `fatal` check blocks package finalization.
- Unknown rights/privacy responsibility is at least `blocker`; it becomes `fatal` when delivery profile marks output as external/public.
- Fatal review findings in `review_report.yaml` always produce a fatal release check unless tied to an approved creative override.
- Waivers require `approved_by`, `approved_at`, `scope`, `reason`, and `expires_at` or `applies_to_artifact_hash`.

## 6. Existing M4 Ownership Boundaries

The new production-readiness artifacts must not steal ownership from existing M4 artifacts. They may cite hashes, freshness, and pass/fail states, but they should not duplicate source-of-truth content.

| Existing artifact / plane | Existing source-of-truth responsibility | New artifact responsibility | Boundary |
| --- | --- | --- | --- |
| `caption_approval.json` | approved caption text, caption timing, text overlay approval, base timeline binding | `release_safety_report.yaml` cites hash/pass/freshness; `caption_plan.json` may later map audio node refs to caption approval | caption text/timing approval stays in `caption_approval.json` |
| `music_cues.json` | BGM cue timing, volume/ducking, base timeline binding | `audio_story_graph.json` provides source audio/music evidence refs; `release_safety_report.yaml` checks hash/freshness and missing rights declarations | music cue timing stays in `music_cues.json`; story graph does not author cue decisions |
| `package-qa-report.json` | measured output QA, technical pass/fail, package measurements | `release_safety_report.yaml` aggregates pass/freshness and delivery compatibility | technical measurements stay in package QA |
| `package_manifest.json` | deliverable inventory, package provenance, output file hashes | `release_safety_report.yaml` verifies completeness and cited source/report hashes | final package file list stays in package manifest |
| `handoff_resolution` | source-of-truth decision between timeline, package, and handoff planes | `release_safety_report.yaml` records whether the required handoff decision exists and is fresh | handoff decision logic stays in the handoff artifact/flow |
| `review_report.yaml` | editorial quality and fatal review issues | `release_safety_report.yaml` imports fatality status as release input | editorial judgment stays in review report |

Severity boundary:

- `unresolved_blockers.yaml.blockers[].status == blocker` blocks planning/compile.
- `review_report.yaml.fatal_issues` blocks editorial approval/final render under existing rules.
- `release_safety_report.yaml.checks[].severity` is package/release scoped and only blocks packaging in `mode: enforce`.

## 7. Additional Artifact Handling

### `delivery_profiles/*.yaml`

Purpose:

- Define target platform and deliverable constraints before final render: aspect ratio, resolution, frame rate, loudness, true peak, caption mode, sidecar format, duration bounds, file naming, metadata, privacy/rights strictness, and public/internal release mode.

Producer:

- `/package` setup or explicit operator command.

Consumers:

- render pipeline, package QA, release safety, package manifest.

Gate behavior:

- Required for `approved -> packaged` only after P4 release safety enforcement.
- If absent before P4, `/render` may produce a review preview but must not claim a release-grade deliverable.
- Multiple profiles should be allowed so platform-specific outputs do not overload a single file.

### Confidence Calibration Fields And Eval Report

Current analysis schemas already have `confidence-record` and `provenance-record`. Production readiness should add calibration without breaking existing fields.

Additive fields:

- `confidence.score`: provider/model self-reported or normalized score.
- `confidence.status`: `raw`, `calibrated`, `human_verified`, `low_signal`, `unsupported`.
- Future schema fields under each confidence record: `calibration_model_id`, `calibrated_score`, `confidence_bucket`, `expected_error_rate`, `eval_set_id`.

Eval report:

- Proposed path: `projects/<id>/08_eval/confidence_calibration_report.json`.
- Producer: eval command, not runtime compiler.
- Required fields: `version`, `project_id`, `created_at`, `eval_set_id`, `artifact_versions`, `metrics`, `buckets`, `failures`, `recommendations`.
- Metrics: boundary error, tag precision/recall, peak timestamp error, speaker attribution accuracy, continuity match precision, release safety false-negative checks.

Gate behavior:

- Confidence calibration must not block MVP compile.
- It may become a release gate only when a delivery profile declares `requires_calibrated_confidence: true`.

### `segment_search_index`

Purpose:

- Enable multimodal search across transcript text, visual tags, segment summaries, audio events, continuity entities, and embeddings.

Structure:

- `03_analysis/search/segment_search_index.json`: manifest and lexical index.
- `03_analysis/search/segment_text_index.json`: normalized text fields and token refs.
- `03_analysis/search/segment_embedding_manifest.json`: embedding provider, model, dimensions, vector shard paths, artifact hashes.
- Vector shards are derived rebuildable artifacts, not canonical source of truth.

Index fields:

- `segment_id`, `asset_id`, `candidate_refs`, `src_in_us`, `src_out_us`, `summary`, `transcript_excerpt`, `visual_tags`, `audio_event_refs`, `audio_story_node_refs`, `continuity_entity_refs`, `embedding_refs`, `quality_flags`, `rights_privacy_flags`.

Gate behavior:

- Search index absence must not block compile or final render.
- Stale index blocks only search-dependent workflows and batch retrieval jobs.
- If search results influence `selects_candidates.yaml`, that artifact's `provenance` must persist search manifest hash, embedding provider/model/dimensions, and stale policy.
- Full-autonomy triage may block on stale search; interactive triage may warn and continue.

## 8. Gate Integration

### No Timeline Compilation If Blocker Exists

Compilation must remain blocked when any of the following is true:

- `unresolved_blockers.yaml.blockers[].status == blocker`.
- `analysis_coverage_report.summary.status == blocked`.
- `project_state.yaml.gates.analysis_gate == blocked`.
- `project_state.yaml.gates.planning_gate == blocked`.
- Required MVP graph for the chosen workflow is missing:
  - `audio_story_graph.json` is required for dialogue/music-driven planning unless scoped override exists.
  - `continuity_graph.json` is required for multi-asset chronological projects unless scoped override exists.
- `editorial_preference_memory.jsonl` has malformed active entries within the consumed hash/offset required by `edit_blueprint.yaml`.

Allowed exception:

- `analysis_coverage_report.summary.status == partial_override` and `project_state.yaml.analysis_override.status == active`, with scope matching the missing lanes and consumers.

### No Final Render Or Package Enforcement

P1-P3:

- `release_safety_report.yaml` is absent-ok or report-only.
- Existing final render blockers remain: fatal review issues, existing package QA rules, schema validation, and source-of-truth declaration.
- Report-only release blockers must be visible in `status`, but they do not block existing demo/render flows.

P4 enforce mode:

- `review_report.yaml.fatal_issues.length > 0` and no matching `approval_record.status == creative_override` blocks.
- `release_safety_report.yaml.mode == enforce` and `summary.status == blocked` blocks.
- Any unwaived `release_safety_report.checks[].severity == fatal` blocks.
- `package-qa-report.json.passed != true` blocks.
- Required `delivery_profiles/*.yaml` is missing for public/external delivery blocks.
- `source_media_manifest.json` reports missing, stale, or unlicensed source files used by `timeline.json` blocks.

### `project_state.yaml` Reflection

Future schema extension should add or formalize these fields under existing `artifact_hashes` and `gates`:

- `artifact_hashes.source_media_manifest_hash`
- `artifact_hashes.analysis_coverage_report_hash`
- `artifact_hashes.audio_story_graph_hash`
- `artifact_hashes.continuity_graph_hash`
- `artifact_hashes.editorial_preference_memory_hash`
- `artifact_hashes.delivery_profile_hash`
- `artifact_hashes.release_safety_report_hash`
- `artifact_hashes.segment_search_index_hash`
- `gates.analysis_gate`: `ready | partial_override | blocked`
- `gates.planning_gate`: `ready | partial_override | blocked`
- `gates.compile_gate`: `open | blocked`
- `gates.review_gate`: `open | blocked`
- `gates.packaging_gate`: `open | blocked | report_only`

Recommended status projection:

```yaml
analysis:
  status: ready
  artifact_version: analysis-v3
  coverage_report_hash: sha256:...
  source_media_manifest_hash: sha256:...
  override_id: null
safety:
  mode: report_only
  status: pass
  release_safety_report_hash: sha256:...
  fatal_count: 0
  blocker_count: 0
```

This is a future schema change, not part of this docs-only task.

## 9. Implementation Roadmap

### P0: Docs And Schema Design Only

Dependencies:

- Current architecture, schema strictness policy, existing M4 package/caption/music artifacts, and gate vocabulary.

Tasks:

- Finalize this v2 design.
- Draft schema proposals for six MVP artifacts without modifying `schemas/`.
- Define fixture names, artifact paths, producer/consumer boundaries, state/gate mapping, versioning, and hash policy.
- Define phase-owned file allowlists before implementation.
- Capture `git status --short` snapshot in the implementation plan or review artifact before any code/schema work starts.

Exit criteria:

- No implementation files changed.
- Review agrees on artifact paths, producers, consumers, gate behavior, and P4 release safety migration.
- Existing dirty worktree is explicitly treated as baseline context; enforcement remains feature-flagged off until phase-specific changes are isolated.

### P1: Manifest + Coverage Foundation

Dependencies:

- P0 artifact path decisions.
- Existing `assets.json`, `segments.json`, `analysis-common`, and `project_state.yaml` gates.

Tasks:

- Add schemas and fixtures for `source_media_manifest.json` and `analysis_coverage_report.json`.
- Generate `source_media_manifest.json` before analysis.
- Generate/update `analysis_coverage_report.json` per analysis lane.
- Reflect coverage in `project_state.yaml.gates.analysis_gate`.
- Add tests for ready, partial, skipped, failed, stale source, missing source, and override states.
- Keep `release_safety_report.yaml` absent-ok/report-only.

Exit criteria:

- `media_analyzed` cannot be reached with missing required raw lanes unless an explicit analysis override exists.
- `analysis_coverage_report.summary.status == ready` requires `source_manifest` lane ready.
- Existing demo timeline compilation remains byte-stable when new gates are disabled or report-only.

### P2: `audio_story_graph`

Dependencies:

- P1 manifest and coverage report.
- Existing STT, diarization, `audio-events.schema.json`, BGM analysis, transcript artifacts.

Tasks:

- Add schema and fixtures for dialogue-heavy, music-only, and failed-STT cases.
- Build graph from transcripts, speaker turns, audio events, BGM sections, and manifest-backed source refs.
- Project stable node refs into `selects_candidates.yaml` / `edit_blueprint.yaml` rather than making compiler read the graph directly.
- Add review checks for missing setup/payoff and awkward audio transitions.
- Optionally run a P2 pilot on dialogue/music-driven fixtures if P1 foundation is stable.

Exit criteria:

- Dialogue/music-driven fixtures can explain selected clips through audio story node refs.
- Compiler remains deterministic and provider-free.
- Missing audio graph affects `planning_gate`, not `media_analyzed`.

### P3: `continuity_graph` And `editorial_preference_memory`

Dependencies:

- P1 source manifest and coverage.
- P2 graph projection pattern.
- Existing candidate refs and review/import/human notes flow.

Tasks:

- Add continuity graph schema and fixtures for chronological, editorial reorder, duplicate, and deliberate discontinuity cases.
- Add append-only JSONL preference schema and loader.
- Store consumed preference log hash/offset in blueprint provenance.
- Add stale detection when preference memory changes after blueprint generation.
- Define graph patch workflow for human corrections.

Exit criteria:

- Multi-asset chronological projects cannot compile automatically without continuity coverage or override.
- Preference conflicts produce unresolved blockers instead of silent planner choices.
- Malformed JSONL behavior returns precise quarantine/last-known-good diagnostics.

### P4: Release Safety Enforce, Delivery, Eval, And Search

Dependencies:

- P1 source manifest/coverage.
- P2/P3 graph and preference projection.
- Existing M4 package manifest, package QA report, review report, caption approval, music cues, and handoff resolution.

Tasks:

- Add `release_safety_report.yaml` schema and preflight with `mode: dry_run | report_only | enforce`.
- Keep `dry_run` first, then `report_only`, then migrate selected workflows to `enforce`.
- Add `delivery_profiles/*.yaml` and package QA mapping.
- Add confidence calibration fields and `confidence_calibration_report.json`.
- Add `segment_search_index` manifest and rebuild command.
- Persist search manifest hash in `selects_candidates.yaml.provenance` when search influences triage.
- Promote `packaging_gate` enforcement only after existing demo/package fixtures pass with report-only blockers resolved or waived.

Exit criteria:

- `approved -> packaged` requires release safety pass or explicit scoped waiver only in `mode: enforce`.
- Search index can be rebuilt from canonical artifacts.
- Confidence calibration remains advisory unless delivery profile opts into it.
- Existing M4 caption/music/package artifacts remain source-of-truth for their fields.

## 10. Acceptance Conditions

Schema validation:

- Every new canonical artifact has a closed schema, fixture, valid example, invalid example, and validator coverage.
- New MVP artifacts include `version`, `artifact_version`, `provenance`, and declared hash policy.
- JSONL preference memory validates line-by-line and reports malformed line numbers and byte offsets.
- YAML artifacts have deterministic normalized JSON equivalents for hashing.

Fixtures:

- Add fixtures for at least:
  - dialogue-heavy interview
  - music-driven montage
  - multi-asset chronological keepsake
  - partial STT failure
  - missing source file
  - stale source file
  - fatal release safety issue
  - report-only release safety blocker
  - preference conflict
  - search-dependent triage provenance

Compiler no-randomness:

- Compiler must not call STT, VLM, embeddings, search, or graph builders.
- Compiler input remains `edit_blueprint.yaml`, `selects_candidates.yaml`, compiler defaults, and existing deterministic policy/registry files.
- If graph-derived signals affect compile, they must be materialized before compile with stable hashes.

Existing timeline compatibility:

- Existing `timeline.json` schema behavior remains valid.
- Existing fixtures without new artifacts must either compile unchanged or fail only when a newly introduced gate is explicitly enabled for that workflow.
- `timeline.json.clip.metadata` may carry graph refs, but timeline identity and editorial surface hashing must remain compatible with existing M4 rules.

Dirty worktree safe introduction:

- Introduce docs/schema/fixtures in isolated commits.
- Do not reformat unrelated docs or generated package files.
- Before implementation, capture `git status --short` and only stage files owned by the phase.
- Add gates in dry-run/report-only mode before enforcing them.
- Keep rollback simple: disabling the new gate should restore existing compile and render behavior.

## 11. Unresolved Decisions

STT and diarization provider:

- Current runtime config points to OpenAI audio with diarization enabled, while connectors also include Groq and pyannote. The canonical graph schema should not bake in one provider.
- Decision needed: allowed provider matrix, fallback order, and minimum diarization confidence for speaker-linked story nodes.
- Recommended direction: provider-agnostic schema fields plus a minimal fixture/eval acceptance matrix.

Face/privacy detection:

- Continuity graph benefits from subject identity, but face recognition and privacy policy are not yet bounded.
- Decision needed: whether to store anonymous subject clusters only, whether human confirmation is required, and how public-release profiles treat minors or sensitive faces.
- Recommended direction: continuity graph stores anonymous editing clusters; `privacy_face_review_report.yaml` owns release risk.

Embedding provider:

- Runtime config may reference a preview embedding provider, but search index must be provider-agnostic and rebuildable.
- Decision needed: embedding model pinning, vector dimensions, local vs remote storage, and stale index invalidation.
- Recommended direction: search manifest pins provider/model/dimensions/hash; runtime config remains default selection.

Rights responsibility boundary:

- Release safety can report missing rights data but cannot legally determine rights ownership by itself.
- Decision needed: which fields are operator declarations, which are machine checks, and who can approve waivers.
- Recommended direction: rights register stores operator declarations; release safety detects missing/stale/incompatible declarations.

Human approval UI:

- Preference memory, release waivers, privacy confirmations, and analysis overrides require explicit human approval.
- Decision needed: CLI-only first, editor UI panel, or both; also decide how approval identity is recorded.
- Recommended direction: canonical CLI approval command first; editor panel later calls the same command/API.

Canonical vs derived search:

- Search index should be rebuildable, but its manifest may become important for batch agent workflows.
- Decision needed: whether stale search blocks only search features or also agent triage in full-autonomy mode.
- Recommended direction: full-autonomy blocks on stale search when search influenced triage; interactive mode warns and continues.

Graph mutation workflow:

- Audio story and continuity corrections are inevitable.
- Decision needed: whether corrections are appended as patch artifacts, edited through a controlled command, or regenerated from human notes.
- Recommended direction: `*_graph_patch.jsonl` plus materialized graph hash.

Provider confidence calibration:

- Confidence is useful but current provider scores are not directly comparable.
- Decision needed: eval-only, delivery-profile opt-in, or always-on analysis gate.
- Recommended direction: eval-only until a delivery profile explicitly opts into calibrated confidence.

Revenue distribution:

- Commercial/public releases may need revenue split declarations, but most MVP and local-family workflows do not.
- Decision needed: whether `revenue_distribution.yaml` is a generic later-tier artifact or domain-specific extension.
- Recommended direction: defer until a commercial release workflow needs it.

## 12. Revision Log

Revision source: `docs/production-readiness-canonical-artifacts-review.md` with verdict `major-revision-required`.

Summary:

- Critical: 4/4 incorporated, 0 deferred.
- Major: 8/8 incorporated, 0 deferred.
- Missing artifacts: 13/14 incorporated, 1 deferred.
- Total review items: 25/26 incorporated, 1 deferred.

### Critical Issues

- [x] C1. `source_media_manifest.json` promoted from Next Tier to Required MVP; MVP count is now six, and coverage/release/graph dependencies explicitly cite it. Cost: M. Decision: incorporated because it is the foundation for P1 and removes the v1 contradiction.
- [x] C2. `media_analyzed` no longer means graph/planning readiness; `analysis_gate` and `planning_gate` now own readiness and partial override transitions. Cost: L. Decision: incorporated because it prevents state-machine double gating.
- [x] C3. `release_safety_report.yaml` is report-only/absent-ok through P1-P3 and enforces only after P4 migration. Cost: L. Decision: incorporated because package enforcement has broad blast radius.
- [x] C4. Existing M4 caption/music/package ownership boundaries are now explicit, with release safety defined as an aggregate/freshness report. Cost: M. Decision: incorporated because source-of-truth ambiguity would break M4 integration.

### Major Issues

- [x] M1. Added gate vocabulary and artifact-to-gate matrix, including `planning_gate`. Cost: M. Decision: incorporated.
- [x] M2. Split `blocker` and `fatal` by plane: planning/compile, editorial review, and package/release. Cost: S. Decision: incorporated.
- [x] M3. Added unified `version`, `artifact_version`, `base_timeline_version`, artifact hash, and provenance hash policy. Cost: M. Decision: incorporated.
- [x] M4. Added JSONL correction/redaction/migration behavior through quarantine, last-known-good offset, and later `artifact_migration_log.jsonl`. Cost: M. Decision: incorporated.
- [x] M5. Reframed roadmap as P1 foundation and P2 audio story pilot, preserving the option to pilot dialogue/music fixtures after source+coverage. Cost: M. Decision: incorporated.
- [x] M6. Added search manifest hash/model/stale policy persistence in `selects_candidates.yaml.provenance` when search influences triage. Cost: M. Decision: incorporated.
- [x] M7. Expanded source manifest fields for timezone, timecode, sample rate, duration, frame-rate mode, rotation, A/V offset, and clock source. Cost: M. Decision: incorporated.
- [x] M8. Added P0 dirty-worktree gates: status snapshot, phase-owned allowlist, report-only/feature-flag introduction, and isolated commits. Cost: S. Decision: incorporated.

### Missing Artifacts

- [x] Missing 1. `source_media_manifest.json` as MVP foundation, including sync/timecode fields. Cost: M. Decision: incorporated as Required MVP.
- [x] Missing 2. `caption_plan.json` or explicit caption source/approval mapping. Cost: M. Decision: incorporated as Next Tier, with M4 boundary that `caption_approval.json` remains source-of-truth.
- [x] Missing 3. `title_overlay_plan.json` / telop timing lane. Cost: M. Decision: incorporated into `caption_plan.json` boundary because existing `caption_approval.text_overlays` already owns approval.
- [x] Missing 4. `rights_license_register.yaml`. Cost: L. Decision: incorporated as Next Tier.
- [x] Missing 5. `release_forms_register.yaml`. Cost: L. Decision: incorporated as Later Tier.
- [x] Missing 6. `privacy_face_review_report.yaml`. Cost: L. Decision: incorporated as Next Tier and as privacy owner separate from continuity graph.
- [x] Missing 7. `identity_alias_register.yaml`. Cost: M. Decision: incorporated as Later Tier.
- [x] Missing 8. `emotion_tone_map.json`. Cost: M. Decision: incorporated as Later Tier.
- [x] Missing 9. `voice_quality_report.json`. Cost: M. Decision: incorporated as Later Tier.
- [x] Missing 10. `sfx_jingle_cues.json`. Cost: M. Decision: incorporated as Later Tier.
- [x] Missing 11. `delivery_profiles/*.yaml`. Cost: M. Decision: incorporated as Next Tier and P4 dependency.
- [x] Missing 12. `sync_quality_report.json`. Cost: M. Decision: incorporated as Next Tier and coverage lane candidate.
- [ ] Missing 13. `revenue_distribution.yaml`. Cost: M/L depending on commercial workflow. Decision: deferred because it is irrelevant to MVP local production-readiness and should be domain-specific until a commercial/public revenue workflow exists.
- [x] Missing 14. `artifact_migration_log.jsonl`. Cost: M. Decision: incorporated as Later Tier and referenced by JSONL redaction/migration policy.

### Recommended Top 5

- [x] Top 5.1. Promoted `source_media_manifest.json` to MVP foundation and resolved Required MVP/P1/coverage/release dependency mismatch.
- [x] Top 5.2. Reworked state machine semantics around `media_analyzed`, `analysis_gate`, `planning_gate`, `analysis_gate.partial`, and `analysis_override.active`.
- [x] Top 5.3. Split `release_safety_report.yaml` report-only from P4 enforcement and added `dry_run | report_only | enforce`.
- [x] Top 5.4. Added existing M4 ownership table for caption, music, package QA, package manifest, handoff, and review.
- [x] Top 5.5. Added unified versioning and hash policy for `version`, `artifact_version`, `base_timeline_version`, `artifact_hashes`, and `provenance.hash`.

### Self-Review Against Update-Design Rubric

- Score: 92/100.
- Remaining deductions: implementation task details still require schema PRs and exact fixture names (-3), unresolved provider/privacy/revenue decisions remain by design (-3), and package enforcement migration still needs runtime verification during P4 (-2).
- Fatal insufficiency check: none. Purpose, scope, dependencies, gate behavior, acceptance conditions, risk controls, and unresolved decisions are now connected.
- P0 readiness: ready.
