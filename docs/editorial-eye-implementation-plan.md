# Editorial Eye: verified implementation plan

Status: implementation-ready plan
Date: 2026-07-19
Scope: source observation, editorial relationships, rendered QA, and explicit human learning

## 1. Outcome

The universal capability should not be a universal aesthetic score. It should be a traceable loop:

1. observe the material without inventing facts;
2. describe each shot in genre-neutral terms;
3. evaluate relationships between adjacent shots and across a sequence;
4. judge those relationships against the brief and editorial profile;
5. learn only from explicit human acceptance or rejection.

The current system already has strong pieces for progressive viewing, searchable evidence, deterministic compile, rendered QA, and patch-based repair. The largest gap is that those pieces do not yet form one trustworthy visual decision loop.

## 2. Verified blockers

### B0. A successful VLM result does not currently prove that an image was seen

- `runtime/pipeline/stages/vlm.ts` calculates timestamps and constructs names such as `frame_2500000.jpg`, but it does not extract those files or receive a source path.
- `runtime/connectors/gemini-vlm.ts` attaches only frame paths that exist. Missing paths are silently omitted.
- Therefore the live connector can receive prompt/transcript text with zero images and still return visual summary, tags, quality flags, and aesthetic scores.
- Existing integration tests inject mocks that do not require the image files to exist, so they prove schema flow but not visual grounding.
- VLM provenance reports `frame_count` from output interest-point count, not the number of input images actually attached.
- Peak precision follows the same filename-without-extraction pattern, so a claimed frame-refined peak is not guaranteed to have inspected that frame either.
- Legacy triage treats existing Marlin provenance as a reason to omit direct frame inputs, institutionalizing text-first selection without distinguishing asset-level derived text from segment-local pixel evidence.

This is the first implementation priority. A system cannot improve its eye until every claimed visual observation is grounded in actual pixels.

### B1. Requested source inputs can disappear before the readiness gate

- `source_media_manifest.json` recognizes `video`, `audio`, `image`, `sequence`, and `unknown`.
- Full-pipeline discovery accepts only a small set of video extensions and fails with `No source video files`.
- Preflight, source-map resolution, rendering, and the manifest each use different extension sets.
- Audio-only, still-image, and image-sequence material now have complete end-to-end lanes. EYE-070C2B gives grounded still images a complete C1 normalize/ground, C2A plan/compile, and canonical FFmpeg/Remotion render lane. EYE-070D1 groups and analyzes explicitly scanned strict numbered image sequences, and EYE-070D2 carries their ordered original frame-set identity plus normalized proxy identity through planning, compile, render, package, and QA freshness. Still execution is intentionally static, while requested Ken Burns motion remains explicit `pending_EYE-070C2B` until cross-renderer parity is implemented.
- Ingest mapping drops per-file failures from its successful result set, and the gap report iterates successful assets rather than every requested input.
- Empty asset/segment arrays are schema-valid, so an all-input failure can lose the failed sources and still project an empty gap set toward `ready`.

The product must stop treating manifest recognition as end-to-end support. Every requested source needs a durable `ready | unsupported | failed` disposition, and each media kind needs an explicit lane capability and degraded status.

### B2. Observation and aesthetic judgment are mixed

- The VLM rubric scores static material as low `motion_quality` and no visible face as low `emotional_expression`.
- This penalizes intentional stillness, landscapes, product details, title cards, and non-human subjects independent of editorial intent.
- The footage DB has useful cinematography fields, but many are inferred by phrase parsing over Marlin text, summaries, quality flags, and labels with fixed confidence caps.
- Appraiser output labels model judgments as `measured: true`, collapsing inferred appraisal into deterministic measurement.
- Footage-search text/vector bundles mix transcript, OCR, place, quality flags, and aesthetic notes, so retrieval scores cannot expose whether a match came from observable content or a prior subjective judgment.
- Confidence and provenance are optional in current asset/segment contracts, allowing derived claims to survive without a machine-checkable evidence source.

Facts such as shot scale, subject position, motion direction, exposure, and text presence must be stored separately from intent-relative judgments such as suitability, beauty, or emotional effectiveness.

### B3. Segment visual evidence is not wired into normal compile

- `adjacencyDecide()` accepts `segmentEvidenceIndex` and uses it for motion, scale, composition, gaze, axis, and peak evidence.
- The normal `compile()` call does not pass that index.
- The footage DB is searchable, but raw DB rows are not an appropriate hidden compiler dependency because the canonical planning loop is artifact-driven and deterministic.
- Current missing-data fallbacks often become a neutral `0.5`, which is indistinguishable from genuine neutral evidence.

Compiler evidence must be materialized from canonical `segments.json`, with explicit coverage and unknown state. The compiler must not query models or SQLite during compilation.

### B4. Current Rule-of-Six labels overstate visual coverage

- `eye_trace.same_asset_adjacency` detects same-asset neighbors and accepts explicit punch-in differentiation.
- `plane_2d.motif_overuse` counts repeated motif tags.
- These checks are useful, but they do not measure the viewer's attention location, motion flow, shot-scale relationship, screen direction, luminance/color jump, or text/face placement.
- Review-side calls to `buildPairEvidence()` also omit segment evidence.

Existing metric IDs should remain for compatibility, while new relation-aware checks are added with truthful `pass`, `warn`, `fail`, or `skipped` semantics.

### B5. Genre fallback can apply interview taste to unknown work

- Profile inference covers a limited set of structured rules.
- No-match and inference-disabled paths default to `interview-highlight` / `interview` while also marking `insufficientSignal`.

Unknown work needs a conservative `generic-editorial` profile or an explicit confirmation gate. It must not silently inherit interview-specific taste.

### B6. QA search cannot currently expand beyond the initial selects pool

- QA fix proposal searches the footage DB.
- `chooseReplacement()` and the variety equivalent discard every search result not already present in `selects.candidates`.
- The applier can already materialize a candidate from `segments.json`, but the proposer never allows that result through.

The proposer and applier contracts need to meet at a segment-backed candidate snapshot so repair can discover genuinely new footage without bypassing quality, evidence, or beat-eligibility checks.

### B7. Human learning is infrastructure without a complete product loop

- The preference-memory schema supports blueprint acceptance and review-patch acceptance/rejection events.
- Normal runtime planning reads `00_project/editorial_preference_memory.jsonl` behind `ENABLE_P3_CONTINUITY_PREFERENCE`.
- Before EYE-060 path unification, Studio indexing, release safety, and segment-search indexing referenced the legacy analysis location instead.
- Runtime code currently appends preference memory from Premiere import, not from normal Studio patch acceptance/rejection.

The path must be unified before adding writers. Learning must be explicit, append-only, attributable, scoped, and reversible by supersession/redaction. Preview, save, or mere patch generation must never train preferences.

### B8. The current QA loop can preserve or apply visually worse, unapproved changes

- Command full-pipeline can apply a generated review patch without confirming that collaborative review reached human acceptance.
- QA iteration backups are restored on compile/render exceptions, but not when the next evaluation is flat or below the quality floor.
- The final post-iteration evaluation may not have a matching final report, so the index hash and last report can describe different timeline states.
- Editorial pipeline status can be written as passed even when rendered visual QA is unavailable or blocked.
- Dashboard counts conflate proposed fixes with applied fixes.

This must be corrected before preference learning is enabled. Otherwise the system can learn from or preserve outcomes that its own evaluation rejected.

### B9. Optional analysis is not consistently fail-open or freshness-safe

- The ingest pipeline catches Marlin reporter failures and immediately rethrows them, so an optional local-model failure can abort the complete analysis run.
- Footage search falls back for a missing or malformed database, but a database explicitly classified as `stale` is still queried; the warning does not prevent old rows from becoming current editorial evidence.
- The canonical full-pipeline and legacy `/triage` routes do not share one retrieval contract, so some selection paths can bypass footage-DB retrieval and its evidence/freshness handling entirely.
- The analysis cache identity uses only a prefix of the source plus size/duration, omitting full-content, policy, model, prompt, and tool revisions; changed evidence can therefore reuse an old result.
- Asset-wide Marlin scene summaries are copied onto individual segments, making non-local evidence look segment-local.

Degraded analysis must remain usable without making stale or absent evidence look current. Optional producers may fail; their coverage and consumer impact must be explicit, and stale derived stores must fall back to canonical artifacts or be rebuilt before use.

## 3. Target architecture

```text
source pixels/audio
  -> grounded observation
  -> canonical segment observation + confidence + provenance
  -> candidate/select materialization
  -> adjacent-pair and sequence relation analysis
  -> brief/profile-relative editorial judgment
  -> compile diagnostics + rendered QA
  -> explicit human accept/reject
  -> scoped preference memory for the next planning run
```

### Authority boundaries

| Data | Authority | Consumer rule |
|---|---|---|
| Source identity and media kind | `source_media_manifest.json` | Inventory and lane routing only |
| Per-segment observable facts | `segments.json` | Canonical source for compile/planning evidence |
| Search acceleration and derived metadata | `03_analysis/search/footage.db` | Rebuildable; never the only compiler input |
| Editorial intent | `creative_brief.yaml`, resolved profile/policy | Controls judgment, not observation |
| Candidate decision | `selects_candidates.yaml` | Carries selected evidence, risks, and eligibility |
| Sequence decision | `edit_blueprint.yaml` | Authored structure and intentional contrast |
| Deterministic execution | `timeline.json` | Compiler output; no model calls |
| Human learning | `00_project/editorial_preference_memory.jsonl` | Explicit acceptance/rejection only |

## 4. Required invariants

1. A successful visual observation has at least one existing, non-empty image input and records its real input count.
2. Missing pixels produce a gap/skipped state, never a visually grounded success.
3. `unknown`, `not_applicable`, and `not_visible` are different from a neutral score.
4. No-face, no-motion, darkness, repetition, or discontinuity is not automatically bad; it becomes a defect only relative to technical validity and editorial intent.
5. The compiler reads canonical artifacts and remains deterministic, local-first, and model-free.
6. Missing optional model/cache dependencies remain fail-open, but degraded coverage is visible and cannot silently pass a visual gate.
7. An intentional contrast needs explicit brief, beat, craft, or human evidence. Discontinuity alone does not prove intention.
8. Human preference memory is never written from preview, generation, or implicit behavior.
9. New source kinds are advertised as supported only after ingest-through-render acceptance tests pass.
10. Every requested source ends in exactly one explicit disposition; no failed or unsupported input disappears from coverage accounting.

## 5. Implementation slices

### EYE-005 — Make QA iteration and approval semantics safe

Priority: P0
Dependencies: none

Implementation:

- Never apply a collaborative review patch until the required human acceptance state is present.
- Persist rejected-operation reasons, not only the filtered patch.
- Treat each QA mutation as a transaction: evaluate the result, then commit only on measured improvement and quality-floor compliance; otherwise restore selects, blueprint, timeline, render, and in-memory values.
- Always write a final evaluation report whose timeline hash equals the QA improvement index result hash.
- Distinguish `proposed`, `applied`, `skipped`, `rejected`, and `rolled_back` fix dispositions.
- Do not mark QA passed when live rendered visual QA is blocked or missing.

Primary files:

- `runtime/commands/full-pipeline.ts`
- `runtime/commands/review/index.ts`
- `runtime/eval/qa-loop.ts`
- `runtime/eval/qa-improvement-report.ts`
- `scripts/editorial-pipeline.ts`
- `apps/macos-studio/Sources/VideoOSStudioCore/QADashboardDocument.swift`
- QA loop, command pipeline, report, and Studio dashboard tests

Acceptance:

- An unaccepted review patch is persisted for review but never compiled into the canonical timeline.
- A flat or lower post-fix score restores every canonical artifact byte-for-byte.
- The last report and index reference the same final timeline hash.
- Blocked visual QA cannot yield a passed status.
- Studio counts actual applied fixes, not proposal count.

### EYE-001 — Ground live VLM calls in real frames

Priority: P0
Dependencies: none

Implementation:

- Pass `sourceFileMap` and the analysis output directory into the VLM stage.
- Extract deterministic sampled frames to `03_analysis/vlm_frames/<asset>/<segment>/` or reuse an equivalent verified frame cache.
- Pass absolute existing paths to `enrichSegment()`.
- If zero frames are extracted, return a failed/skipped enrichment and let the gap report carry the degraded state; do not call the live VLM as visual analysis.
- Record actual attached-frame count, sample timestamps, cache version, and extraction failure in provenance.
- Bump connector/prompt/cache version so text-only cached results are not reused as grounded visual results.
- Apply the same verified-frame contract to peak precision; output timestamps must not be labeled frame-refined when no frame was attached.

Primary files:

- `runtime/pipeline/stages/vlm.ts`
- `runtime/pipeline/ingest.ts`
- `runtime/connectors/gemini-vlm.ts`
- `runtime/pipeline/stages/gap-report.ts`
- `tests/gemini-vlm.test.ts`
- `tests/pipeline-ingest.test.ts`

Acceptance:

- A real-media fixture proves every path received by the VLM mock exists and is non-empty.
- A forced extraction failure makes zero VLM calls and creates a VLM gap.
- A peak-precision mock receives an existing, non-empty frame or records a non-refined degraded result.
- Provenance input-frame count equals the frames attached to the request.
- Existing fail-open behavior, schema validation, typecheck, and cache tests pass.

### EYE-002 — Make degraded analysis truthful and freshness-safe

Priority: P0
Dependencies: none

Implementation:

- Convert Marlin reporter failure from an ingest abort into an explicit gap/partial analysis result while preserving STT, deterministic segmentation, and later fail-open stages.
- Treat a stale footage DB like an unavailable derived cache for editorial search: fall back to canonical `segments.json` or rebuild it before querying.
- Return structured degraded reasons and affected capabilities to callers; warnings alone are insufficient for gates and QA status.
- Route canonical planning and legacy `/triage` through the same retrieval/freshness adapter where retrieval is requested.
- Treat Marlin summaries as derived text evidence, not as proof that legacy triage directly inspected segment pixels; any direct visual claim must satisfy the same grounded-frame contract as the canonical route.
- Keep hard failures for malformed canonical artifacts and source-media integrity errors; fail-open applies only to optional derived analysis.

Primary files:

- `runtime/pipeline/ingest.ts`
- `runtime/pipeline/stages/marlin.ts`
- `runtime/pipeline/stages/gap-report.ts`
- `runtime/artifacts/footage-db.ts`
- `runtime/tools/footage-search.ts`
- `runtime/commands/triage.ts`
- ingest, footage-search freshness, and triage integration tests

Acceptance:

- A forced Marlin worker failure completes ingest with a recorded Marlin gap and usable canonical segments.
- A stale footage DB is never queried; search uses current `segments.json` or a verified rebuild.
- Callers can distinguish `ready`, `partial`, `skipped`, and hard failure without parsing log text.
- Missing Qwen, CLAP, Marlin, or other optional local-model dependencies do not abort the artifact pipeline.
- Malformed canonical `segments.json` still fails loudly rather than being mislabeled as model degradation.

### EYE-003 — Preserve every requested source through readiness accounting

Priority: P0
Dependencies: none

Implementation:

- Introduce one source ledger keyed by canonical source identity and feed it through discovery, manifest, ingest map, gap projection, and readiness gates.
- Record every requested input as exactly one of `ready`, `unsupported`, or `failed`, with stage, reason, and consumer impact.
- Build the gap report from the source ledger plus enrichment results, not only from successfully ingested assets.
- Block readiness when requested inputs exist but no usable asset survives; partial success remains explicit and policy-controlled.
- Centralize extension/media-kind capability ownership so discovery and preflight cannot silently disagree.

Primary files:

- `runtime/pipeline/executor.ts`
- `runtime/pipeline/stages/ingest-map.ts`
- `runtime/pipeline/stages/gap-report.ts`
- `runtime/artifacts/p1-manifest-coverage.ts`
- `runtime/mcp/gap-projection.ts`
- `schemas/assets.schema.json` or a dedicated additive source-ledger artifact schema
- pipeline executor, ingest-map, gap-projection, and real-media fixture tests

Acceptance:

- `requested = ready + unsupported + failed` holds for every run, with stable source IDs across manifest, assets, source map, and footage DB.
- One valid and one failed input produces a truthful partial result containing both dispositions.
- All-input failure can never produce a `ready` analysis gate.
- WAV/PNG inputs remain visible as unsupported until their dedicated lanes are implemented; they do not become zero-segment successes.

### EYE-004 — Make derived-evidence cache identity complete

Priority: P0/P1
Dependencies: EYE-001 for grounded-frame cache identity

Implementation:

- Key analysis and visual caches by full source-content hash, segment range, policy hash, model/runtime revision, prompt/schema version, and producer/tool revision.
- Store the resolved cache identity in provenance and expose why a cached result was accepted or invalidated.
- Invalidate legacy text-only visual results and any cache whose evidence inputs cannot be reproduced.
- Keep asset-level Marlin summaries asset-scoped; only time-local evidence may populate segment observations.

Primary files:

- `runtime/pipeline/analysis-cache.ts`
- `runtime/pipeline/stages/vlm.ts`
- `runtime/pipeline/stages/peak.ts`
- `runtime/pipeline/stages/marlin.ts`
- connector and provenance schemas/tests

Acceptance:

- Changing source bytes outside the first megabyte invalidates cached analysis.
- Changing policy, model, prompt, schema, or tool revision invalidates only the affected producer cache.
- A cache hit identifies all evidence revisions used to authorize reuse.
- Asset-wide summaries are never represented as segment-local measured facts.

### EYE-010 — Add a genre-neutral segment observation contract

Priority: P0
Dependencies: EYE-001

Add an optional top-level `editorial_observation` object to each `segments.json` item. This supersedes the draft idea of placing all adjacency evidence under `peak_analysis`: observation must still exist when peak detection is disabled.

V1 fields:

- `status`: `ready | partial | skipped`
- `visual_tags`
- `motion_type`, `camera_motion_direction`, `subject_motion_direction`
- `shot_scale`, `composition_anchor`, `screen_side`
- `gaze_direction`, `camera_axis`, `dominant_subject_type`
- `avg_luma`, `dominant_colors`, `text_presence`
- grouped confidence for tags, motion, framing, direction, appearance, and text
- provenance with producer, model/runtime, prompt hash, actual frame count, and evidence refs

Rules:

- Every closed enum includes an explicit unknown/applicability value.
- Observation producers may be VLM, appraiser, deterministic measurement, or a conservative merge.
- Disagreement is retained in evidence/warnings; it is not averaged away.
- Asset-scoped descriptions stay asset-scoped and cannot be duplicated as segment-local facts without time-local supporting evidence.
- The existing visual-quality scalar subtree remains compatibility output, but it is no longer the source of observation facts.
- Footage DB builder prefers canonical observation fields and uses phrase parsing only as a lower-confidence fallback.
- Search indexing keeps observable content, technical quality, and aesthetic/editorial judgments in identifiable channels so retrieval can report which evidence class produced a match.

Primary files:

- `schemas/segments.schema.json`
- `runtime/connectors/ffmpeg-segmenter.ts`
- `runtime/connectors/gemini-vlm.ts`
- `runtime/pipeline/stages/vlm.ts`
- `runtime/pipeline/stages/appraiser.ts`
- `runtime/artifacts/footage-db-builder.ts`
- `runtime/artifacts/footage-metadata-extractor.ts`
- relevant schema, VLM, appraiser, and footage-DB tests/fixtures

Acceptance:

- Static landscapes and title cards are not marked low quality merely for no motion/face.
- Unknown direction stays unknown and never becomes center/neutral by default.
- Each concrete field has confidence and provenance.
- `--skip-peak` does not remove observation evidence.
- Old `segments.json` fixtures remain valid because the field is additive.

### EYE-020 — Materialize segment evidence into normal compile

Priority: P0
Dependencies: EYE-010 contract; adapter work can start against fixtures

Implementation:

- Add a pure loader/adapter from `segments.json` to `Map<segment_id, SegmentEvidence>`.
- Map `editorial_observation` to the compiler's `AdjacencyFeatures`; retain peak moments and support signals from `peak_analysis`.
- Pass the index from normal `compile()` into `adjacencyDecide()`.
- Use segment tags plus explicit unknown motion as the backward-compatible fallback for old artifacts.
- Add coverage/status to pair evidence so missing evidence is not indistinguishable from a real 0.5 score.
- Keep SQLite and all model calls outside compile.

Primary files:

- new `runtime/artifacts/segment-editorial-evidence.ts`
- `runtime/compiler/index.ts`
- `runtime/compiler/adjacency.ts`
- `runtime/compiler/transition-types.ts`
- `runtime/compiler/transition-skill-loader.ts`
- `tests/cut-transition.test.ts`
- `tests/compiler.test.ts` or a focused compile integration test

Acceptance:

- A fixture with two different observation sets produces different pair evidence through the normal `compile()` entrypoint.
- An old fixture without observations compiles byte-stably when the rollout flag is off.
- Missing axes are recorded as unknown/skipped and do not satisfy a transition predicate that requires that axis.
- Repeated compiles are byte-identical.

### EYE-021 — Normalize missing-data and transition-score semantics

Priority: P0
Dependencies: can start with EYE-020 fixtures; must land before relation metrics

Implementation:

- Introduce explicit `known | unknown | not_applicable` coverage for pair features.
- Do not convert two missing tag sets into measured overlap `0` or infer a semantic change from that absence.
- Prevent unknown evidence from satisfying skill-card predicates unless the card explicitly allows unknown.
- Choose and document one `energy_delta` domain. The current implementation maps signed delta to `[0,1]`, while at least one skill card compares it to negative values and treats `>0` as energy increase.
- Persist axis coverage and selected-skill reasons so score behavior is inspectable.
- Decouple non-embedding metadata availability from the presence of Qwen embeddings.

Primary files:

- `runtime/compiler/adjacency.ts`
- `runtime/compiler/transition-types.ts`
- `runtime/compiler/transition-skill-loader.ts`
- `runtime/compiler/visual-cache.ts`
- `runtime/editorial/transition-skills/*.json`
- `tests/cut-transition.test.ts`
- compiler visual-cache tests

Acceptance:

- Two missing tag sets remain unknown and cannot independently trigger a crossfade/topic-change rule.
- Equal energy, increase, and decrease fixtures satisfy the documented card predicates.
- Metadata-only compile behavior works when optional visual embeddings are absent.
- Diagnostics distinguish neutral measured values from missing values.

### EYE-030 — Classify cut relationships, not isolated clip quality

Priority: P1
Dependencies: EYE-020

Add a deterministic pair result:

- `continuous`
- `intentional_contrast`
- `risky_jump`
- `unknown`

The result includes coverage, confidence, reasons, and the explicit intent evidence used. Initial features are shot-scale delta, subject/attention position, motion flow, screen direction, luma/color jump, same-subject/same-asset similarity, text-region change, and story/beat boundary.

Intentional contrast may be established only by authored beat/craft/transition intent, profile policy, or explicit human annotation. Low similarity alone is not intent.

Primary files:

- `runtime/compiler/adjacency.ts`
- `runtime/compiler/transition-types.ts`
- `runtime/compiler/transition-skill-loader.ts`
- `schemas/timeline-ir.schema.json` if diagnostics are persisted in the IR
- transition and compiler tests

Acceptance:

- Match, deliberate contrast, accidental jump, and insufficient-evidence fixtures classify correctly.
- Low-confidence gaze/axis never causes a hard continuity failure.
- Pair reasoning is visible in timeline diagnostics or a canonical review artifact.

### EYE-035 — Replace unknown-genre interview fallback

Priority: P1
Dependencies: none; should land before intent-relative hard gates

Implementation:

- Add a conservative `generic-editorial` profile/policy or require confirmation when inference is insufficient.
- Keep technical safety checks, but disable interview-specific taste assumptions.
- Surface `insufficientSignal` as a planning diagnostic instead of silently treating the work as an interview.

Primary files:

- `runtime/editorial/policy-resolver.ts`
- `runtime/editorial/profiles/`
- `runtime/editorial/policies/`
- profile/policy tests and fixtures

Acceptance:

- Unmatched landscape, product, and montage briefs do not resolve to interview defaults.
- Explicit `profile_hint` behavior is unchanged.

### EYE-040 — Add relation-aware review metrics

Priority: P1
Dependencies: EYE-030

Keep current same-asset and motif checks, then add:

- `eye_trace.attention_jump`
- `eye_trace.motion_flow`
- `plane_2d.framing_jump`
- `plane_2d.luma_color_jump`
- `space_3d.direction_axis`

Metrics consume the same pair evidence adapter as compile. Thresholds are profile/brief-relative. Unknown coverage becomes `skipped` or `warn`, never an evidence-free pass.

Primary files:

- `runtime/review/metrics.ts`
- `schemas/review-metrics.schema.json`
- `runtime/eval/qa-issue-detector.ts`
- `tests/review-metrics.test.ts`
- review metric verdict and QA-loop tests

Acceptance:

- An intentional smash cut is not failed by continuity-only thresholds.
- An accidental same-subject/same-scale jump is detected.
- Missing observation produces a truthful coverage warning/skipped result.
- Existing metric IDs and consumers remain compatible.

### EYE-050 — Let QA discover new source footage safely

Priority: P1
Dependencies: canonical segment observation improves ranking but is not required for contract work

Implementation:

- Let the proposer resolve search results against `segments.json`, not only `selects.candidates`.
- Create a bounded candidate snapshot containing segment identity, source range, quality/evidence, search score, and target beat.
- Reuse the applier's segment-backed candidate materialization.
- Require quality floor, source existence, beat fit, and no duplicate use before proposal.
- Persist why the new candidate entered selects.

Primary files:

- `runtime/eval/qa-fix-proposer.ts`
- `runtime/eval/qa-fix-applier.ts`
- `runtime/eval/qa-loop.ts`
- `tests/qa-loop.test.ts`
- focused proposer/applier tests

Acceptance:

- A top search result outside the initial selects pool can be proposed, materialized, compiled, rendered, and evaluated.
- Missing segment metadata or sub-threshold quality is rejected without artifact mutation.
- Failed iteration restores selects, blueprint, timeline, and render backups.

### EYE-060 — Close the explicit human learning loop

Priority: P1/P2
Dependencies: path migration first

Split into two changes:

1. Path unification
   - Canonicalize on `00_project/editorial_preference_memory.jsonl`.
   - Update Studio index, release safety, and segment-search input hashing.
   - Provide an explicit migration/read-compatibility path for legacy `03_analysis` files.
2. Explicit acceptance/rejection writers
   - Add human actions for accepted/rejected blueprint and review/Studio patch outcomes.
   - Store feature-level preference values only when the human confirms they should be remembered.
   - Keep project/profile/series scope explicit and support supersession/redaction.

Primary files:

- `runtime/artifacts/p3-preference-memory.ts`
- `runtime/commands/intent.ts`
- `runtime/commands/blueprint.ts`
- `runtime/artifacts/p4a-release-safety.ts`
- `runtime/artifacts/p4d-segment-search-index.ts`
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectSQLiteIndex.swift`
- `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift`
- Studio patch promotion and preference-memory tests

Acceptance:

- Every consumer resolves the same canonical path.
- Preview/generation/save without explicit remember action writes nothing.
- Acceptance and rejection produce validated, attributable JSONL entries.
- The next intent/blueprint run demonstrably consumes the confirmed preference.
- Supersession and redaction remain append-only.

### EYE-070 — Make media-kind support executable

Priority: P2
Dependencies: EYE-001 and observation contract

Implement and advertise one lane at a time:

1. unify discovery and preflight around the manifest;
2. audio-only lane: probe, STT/audio observation, audio selection, compile, render;
3. still-image lane: duration policy, image observation, pan/zoom safety, compile, render;
4. image-sequence lane: grouping, frame rate/duration/timebase, observation, compile, render.

Each manifest item records lane status and consumer impact. Unsupported or degraded kinds remain visible rather than disappearing from discovery.

EYE-070C1 completes the still-image analysis boundary: JPG/JPEG/PNG and decodable HEIC sources are discovered, identity-checked, normalized to one grounded frame, segmented once, and routed through static VLM and deterministic frame-quality coverage. Physical duration remains zero; its `0..1us` interval is source identity only.

EYE-070C2 is split at the truthful render boundary:

- **C2A selection/planning/compiler core:** a fully grounded C1 image may enter triage, blueprint, and compile. A resolved rational-FPS hold policy produces timeline frames and `still_image` provenance while source identity remains `0..1us`. Static motion is the only executable truth. Completion requires pure and mixed planning-to-compile coverage, exact hold/source invariants, mutation safety, legacy compatibility, and deterministic rejection of incomplete grounding or unsupported sequence media.
- **C2B truthful static rendering (complete):** every canonical FFmpeg, rough-cut, runtime package, promo finishing, and visual-QA entrypoint resolves image inputs from the C1 normalized frame, never from the original or a caller override. Source-input attestation v3 preserves the v2 still contract and binds the full original SHA-256 to the normalized-frame SHA-256, project-relative analysis path, and normalization producer/version. Exact holds use timeline frames and rational FPS; contain/cover/background and static execution are deterministic. H.264 delivery is explicitly opaque `yuv420p`: `transparent` deterministically flattens to black, while `#RRGGBBAA` accepts the alpha-bearing token but retains its RGB background when the output pixel format discards alpha. Remotion uses an image hold at integer FPS with no fabricated audio; rational stills and still timelines with explicit audio/BGM route to FFmpeg, while the corresponding direct Remotion calls fail explicitly before bundling. The independent editor RenderSpec preview remains explicitly unsupported for authoritative still assets because it cannot carry the derived identity; canonical timeline preview is the supported exact-preview path. Invalid/legacy image identity fails before renderer/package/QA side effects.

**EYE-070D1 grouping/ingest/analysis (complete):** only PNG/JPG/JPEG files reached through an explicitly requested directory scan are eligible for grouping. Files must share one directory, prefix, extension, and numeric padding, with at least two members. The analysis policy owns a reduced rational CFR (default `24/1`). Contiguous groups preserve every requested frame in the source ledger and manifest, record an ordered frame-set SHA-256, validate discovery identity and decodeability per frame, reject missing/corrupt/mismatched/oriented frames, normalize through FFmpeg image2 into a deterministic bit-exact FFV1/NUT analysis proxy, and verify decoded frame count plus FPS before segment/VLM/visual-quality analysis. Unchanged proxies preserve mtime so ingest and grounded-VLM caches remain reusable; any frame change invalidates the group, proxy, asset, and analysis identity. Single images and explicitly requested individual image files remain in the still-image lane.

**EYE-070D2 planning/compile/render/QA (complete):** D1 sequence assets may enter triage, blueprint, and compile only when their canonical grouping and normalization metadata, internal per-frame source links, ordered frame-set SHA-256, and FFV1/NUT proxy SHA-256 all agree. FFmpeg assembly, canonical preview, Remotion staging, package reuse, and QA freshness render only a private verified snapshot of that proxy. Source-input attestation v3 records the original frame-set identity separately from the derived proxy identity, so changing any original frame or the proxy makes downstream render/package/QA artifacts stale. Legacy or incomplete sequence artifacts fail closed and require re-ingest.

Accordingly, image and sequence registry support are both `plan=true`, `compile=true`, `render=true`, `consumerImpact=none`, and `unsupportedReason=null`. Marker-stripped timelines are classified from assets/source-map truth. Legacy video artifacts and video caller overrides retain additive compatibility, while pre-C2B image artifacts and pre-D2 sequence artifacts are stale and require re-ingest/re-render. The committed Editorial Eye v1 benchmark fixture remains a historical D1 baseline whose sequence cells are explicitly unsupported; changing that human-bound baseline requires a separately versioned benchmark contract rather than rewriting it in place.

The remaining motion boundary is deliberate: execution is still `motion_mode=static`. A requested `subtle_ken_burns` remains `pending_EYE-070C2B`; no renderer silently synthesizes motion. Completing motion later requires provenance-carried clamped parameters and FFmpeg/Remotion/canonical-preview parity tests.

EYE-070F is complete when every canonical render snapshots the sorted unique set of actually used source assets, verifies live full-file SHA-256 and any declared ingest identity before rendering, rechecks the same usage policy after rendering, and package/visual QA reject or regenerate assemblies whose source-input attestation is missing, invalid, or stale.

Primary files:

- `runtime/pipeline/executor.ts`
- `runtime/preflight.ts`
- `runtime/artifacts/p1-manifest-coverage.ts`
- ingest/segment/derivative stage routing
- compiler/render source-kind handling
- source manifest, pipeline, renderer, and end-to-end fixtures

Acceptance:

- Extension sets have one owner.
- Each claimed kind has ingest-through-render coverage.
- Mixed-media projects preserve all manifest items and report per-lane status.

### EYE-080 — Build an editorial-eye benchmark

Priority: begins with EYE-001 and grows with each slice

Fixture matrix:

- interview/dialogue;
- quiet landscape/documentary;
- product/detail;
- action/event;
- vertical social montage;
- chronological longform;
- intentional jump/smash/match cuts;
- video, audio-only, still, and image sequence.

Measures:

- grounded visual success rate;
- observation field coverage and calibration;
- pair-relation agreement with human labels;
- false hard-fail rate by genre;
- accepted repair rate and rejected repair reasons;
- deterministic compile and degraded-mode stability;
- human pairwise preference, not one global taste scalar.

The first benchmark gate is binary: a visual success with zero verified image inputs is always a failure.

## 6. Dependency order

```text
EYE-005 QA safety ---------------------------------> EYE-060 learning writers

EYE-001 grounded frames
  -> EYE-010 observation contract
      -> EYE-020 compiler materialization
          -> EYE-021 evidence semantics
              -> EYE-030 pair relation
                  -> EYE-040 review metrics

EYE-002 truthful degraded analysis -----------> all observation/search consumers
EYE-003 source ledger -------------------------> EYE-070 media lanes
EYE-001 grounded frames -> EYE-004 cache identity
EYE-035 generic fallback ---------------------> EYE-040
EYE-050 QA discovery can begin independently -> uses EYE-010 when available
EYE-060 path migration -> explicit learning writers
EYE-070 media lanes depend on EYE-001/EYE-010
EYE-080 benchmark grows at every step
```

## 7. Rollout and compatibility

- EYE-001 corrects provenance truth and should not be hidden behind a new feature flag. It remains fail-open by returning a visible gap when extraction is unavailable.
- The observation schema is additive. Old segment artifacts remain valid.
- Compiler use of new relation evidence starts behind `ENABLE_EDITORIAL_EYE_RELATION_V1` until golden comparisons pass.
- New review metrics start advisory. Promotion to blocking requires measured false-positive/false-negative evidence per profile.
- The preference-memory consumer flag stays until path migration and explicit writer tests pass.
- No source kind is labeled supported merely because the manifest can name it.

## 8. Verification gates

Every implementation task must run its focused tests plus:

```sh
npx tsc --noEmit
npx vitest run tests/cut-transition.test.ts tests/review-metrics.test.ts tests/gemini-vlm.test.ts tests/pipeline-ingest.test.ts tests/qa-loop.test.ts tests/editorial-preference-memory.test.ts
npm run verify:repo
```

Run full `npm test` and `npm run verify -- --full` before enabling relation metrics by default. Media-kind slices also require real ffmpeg fixtures and one mixed-media end-to-end render.

## 9. Definition of done

The editorial-eye loop is complete only when:

- every successful visual claim proves which real pixels were seen;
- observation facts are separate from intent-relative judgments;
- normal compile consumes canonical segment evidence;
- adjacent cuts have inspectable relation/coverage diagnostics;
- rendered QA uses those same relations and treats unknown honestly;
- repair can retrieve useful footage outside the initial selects pool;
- accepted and rejected human decisions can influence the next plan only through explicit memory actions;
- each advertised media kind has end-to-end evidence;
- benchmark results improve across genres without encoding one genre as universal taste.
