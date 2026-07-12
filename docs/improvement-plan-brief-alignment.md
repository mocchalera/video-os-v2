# Improvement Plan: Brief-Alignment Scores

## Context

The first `ena-promo` brief-alignment eval scored **80.6% composite**:

- `selects`: **74.5%**
- `blueprint`: **88.0%**

The weak axes are all in the selects stage and all came from the artifact LLM judge:

| Axis | Score | Main judge gap |
| --- | ---: | --- |
| `emotion_curve_alignment` | 60% | Candidate list does not expose emotional beat transitions or per-candidate peak/emotion signals. |
| `narrative_structure` | 60% | Candidate roles do not explicitly say hook/setup/experience/payoff/closing per clip. |
| `pacing_coherence` | 70% | Selects artifact has little cut-density, audio, or rhythm intent. |
| `visual_variety_and_focus` | 70% | Many candidate descriptions are generic, so theme/focus is inferred rather than visible. |

The blueprint is stronger because it contains explicit beat labels, `story_arc`, music policy, duration policy, and pacing fields. The practical problem is not that the brief-alignment judge needs smarter interpretation. The problem is that selects is too thin as an editorial-intent artifact.

North star: **weak agents + structure = quality**. The fix should make intent visible in schema-safe fields before asking later agents or judges to infer it.

Cost architecture constraint:

- VLM remains API-only because it reads frames/video.
- Triage, blueprint, and artifact judging should stay repo-side/subscription-agent friendly where possible because they reason over text/YAML.

## Diagnosis

### Current selects contract

`schemas/selects-candidates.schema.json` is closed at top level and candidate level. The required per-candidate fields are:

- `segment_id`
- `asset_id`
- `src_in_us`
- `src_out_us`
- `role`
- `why_it_matches`
- `risks`
- `confidence`

The useful optional fields already available are:

- `evidence`: free-form strings grounded in segment/brief evidence.
- `eligible_beats`: string labels for beat compatibility.
- `motif_tags`: theme tags.
- `audio_story_refs`: references with `role` enum: `hook`, `setup`, `experience`, `payoff`, `reaction`, `closing`.
- `continuity_refs`: entity/risk references.
- `editorial_signals`: closed object with `afterglow_score`, `speech_intensity_score`, `reaction_intensity_score`, `authenticity_score`, `surprise_signal`, `hope_signal`, `peak_strength_score`, `motion_energy_score`, `audio_energy_score`, `peak_ref`, `peak_type`, `face_detected`, `visual_tags`, and `semantic_cluster_id`.
- `peak_signals`: `motion`, `audio_rms`, and `speech_keyword`.
- `trim_hint`: preferred duration/window/interest-point fields.

This means Sprint 1 does not need schema changes. The existing schema can already carry emotional evidence, visual tags, rough story roles, peaks, and duration hints. The current artifact simply does not populate most of those fields.

### Current triage output

`runtime/agents/llm-triage-agent.ts` compacts each segment to:

- `segment_id`, `asset_id`, source time range
- `summary`
- `tags`
- coarse peak evidence: `has_peak`, `types`, `count`
- normalized transcript
- optional `filmstrip_path`

The triage prompt tells the model to:

- cover every `must_have`
- respect the `emotion_curve` and chronology
- include a clear opening and ending
- maintain breadth across assets, visual modes, and story beats
- select candidates from available footage

But the output shape only demonstrates:

- `selection_notes`
- `editorial_summary`
- candidates with `role`, `why_it_matches`, `confidence`, `semantic_rank`, and `evidence`

The parser keeps only a small subset of optional fields. In practice, even if the model emits richer metadata, `selectsFromLlmResponse` currently preserves only `semantic_rank`, `evidence`, and `rejection_reason` in addition to required fields.

### Current VLM data path

`runtime/connectors/gemini-vlm.ts` already asks VLM for:

- a specific visible-action `summary`
- `tags`
- `interest_points`
- `quality_flags`
- `visual_quality.scores`: `light_quality`, `subject_prominence`, `emotional_expression`, `composition_score`, `motion_quality`
- `visual_quality.labels`: lighting, composition, expression, and motion labels

`runtime/pipeline/stages/vlm.ts` writes those to `segments.json` and provenance. However, triage compaction does not include `visual_quality`, detailed interest-point labels, confidence, or normalized visual-quality labels. It only forwards summary/tags and coarse peak counts.

For `ena-promo`, the latest selects artifact shows the failure mode clearly: candidates often have evidence like `outdoor_scene`, `person_standing`, `trees`, or `smartphone`. Those terms may be true, but they do not prove "quiet lasting impressions", "traditional craft", "warmth", "serenity", or a story role.

### Current scorer and judge needs

`runtime/eval/brief-alignment-deterministic.ts` already exposes why selects scores are weak when structure is absent:

- `scoreSelectsEmotionCurve` rewards active candidates with `editorial_signals` such as `afterglow_score`, `reaction_intensity_score`, `surprise_signal`, `hope_signal`, or `peak_strength_score`. The reported deterministic failure from earlier evals was `0/100 active candidates carry emotion/peak signals`.
- `scoreVisualVariety` can use `editorial_signals.semantic_cluster_id`; without it, it falls back to segment diversity.
- `scorePacingDeterministic` currently applies to blueprint, not selects, because selects has no stage-level pacing policy.
- `scoreNarrativeStructureDeterministic` currently applies to blueprint, not selects, because blueprint has `story_role`; selects does not have an equally direct story-role field.

`runtime/eval/brief-alignment-judge.ts` asks the artifact judge to score six axes from the brief and artifact YAML. For selects, the judge needs to see:

- emotion beat assignment and emotional evidence per candidate
- narrative function per candidate or candidate group
- visual theme/focus evidence that is more specific than generic tags
- pacing intent: likely duration, energy, audio relevance, and where the clip belongs in the arc

The blueprint has those signals. Selects mostly has raw candidates plus broad rationale.

## Root Cause By Weak Axis

### `emotion_curve_alignment` at 60%

Current data:

- The brief emotion curve is passed to triage.
- Candidate `why_it_matches` may mention emotions in prose.
- Schema can carry `editorial_signals` and `peak_signals`.
- Segment input has coarse `peak` evidence and may have `visual_quality.emotional_expression`.

Current gap:

- Triage output shape does not require emotion tags, beat assignment, or emotional transition role.
- Parser does not preserve emitted `editorial_signals`.
- Segment compaction hides most visual-quality detail.
- The judge sees emotional intent as inferred prose, not structured evidence.

What the judge needs:

- `emotion_tags` or equivalent visible in `evidence`/`motif_tags`.
- Per-candidate mapping to one or more brief emotion-curve terms.
- Peak/release evidence: `peak_type`, `peak_strength_score`, `afterglow_score`, `surprise_signal`, `hope_signal`, or similar.
- A stage-level note showing intended progression from opening to closing.

### `narrative_structure` at 60%

Current data:

- Candidate `role` only says `hero`, `support`, `transition`, `texture`, `dialogue`, or `reject`.
- Schema has `eligible_beats` and `audio_story_refs.role`, but triage does not populate them.
- Blueprint later creates beat labels and story roles, which is why blueprint scores well.

Current gap:

- Candidate role is visual/editorial importance, not story function.
- A `support` candidate could be setup, experience, payoff, or closing.
- The candidate list does not tell the judge whether a clip is meant to establish Ena, deepen immersion, prove food/craft, or close with memory.

What the judge needs:

- Per-candidate narrative function: `hook`, `setup`, `experience`, `payoff`, `reaction`, `closing`.
- Short justification that ties that function to the brief.
- Candidate grouping/ordering notes so the transition between story phases is legible before blueprint.

### `pacing_coherence` at 70%

Current data:

- Candidate source durations exist.
- `editorial_summary.motion_profile` and `transcript_density` exist.
- Schema has `trim_hint` and `editorial_signals.motion_energy_score` / `audio_energy_score`.
- VLM and segment metadata can imply motion, but triage does not expose a pacing policy.

Current gap:

- Selects has no stage-level cut-density or rhythm policy.
- Candidates do not explain whether they are long holds, short texture inserts, breathing room, or peak accents.
- Audio policy is in the brief and blueprint, not visible in selects.

What the judge needs:

- Candidate-level `trim_hint.preferred_duration_us` for rough cut intent.
- Motion/audio energy signals where available.
- Stage-level `selection_notes` that declare intended pacing: opening cadence, middle cadence, closing release, and whether clips are held or cut as texture.

### `visual_variety_and_focus` at 70%

Current data:

- Candidate `evidence` contains tags.
- Optional `motif_tags`, `editorial_signals.visual_tags`, and `semantic_cluster_id` exist.
- VLM summary prompt already asks for concrete visible action.
- VLM output includes `visual_quality.labels`.

Current gap:

- Generic VLM tags and summaries are passed directly into candidate evidence.
- Triage does not normalize tags into destination-specific motifs like `mountain_landscape`, `food_preparation`, `craft_detail`, `human_in_landscape`, `aerial_scale`, or `quiet_closing`.
- Segment clusters are not carried into selects, so deterministic variety checks use weaker fallbacks.

What the judge needs:

- Specific, brief-relevant visual motifs per candidate.
- Cluster/theme diversity visible in the artifact.
- Evidence that each motif supports the central tourism PV focus rather than simply adding generic variety.

## Proposed Improvements

### 1. Prompt triage to emit richer data into existing optional fields

Impact: high  
Effort: low, about 0.5-1 day  
Files:

- `runtime/agents/llm-triage-agent.ts`
- focused tests for `buildLlmTriagePrompt` and `selectsFromLlmResponse`

Change:

- Extend the output shape to ask for:
  - `eligible_beats`: brief emotion/story beat labels or planned beat ids when available.
  - `motif_tags`: brief-relevant visual themes.
  - `editorial_signals.visual_tags`: concrete visual themes.
  - `editorial_signals.peak_type` and `peak_strength_score` when segment peak evidence exists.
  - `trim_hint.preferred_duration_us` and `interest_point_label` when useful.
  - `evidence` entries that include at least one visual fact and one brief-link fact.
- Update parser to preserve these existing schema fields safely.
- Add prompt rules that prevent generic-only evidence: if a candidate only has `outdoor_scene` / `person_standing`, the model must either add a more specific observable fact from the filmstrip or lower confidence and list the risk.

Expected score impact:

- `emotion_curve_alignment`: +8 to +15 points
- `narrative_structure`: +5 to +10 points
- `visual_variety_and_focus`: +5 to +10 points
- `pacing_coherence`: +3 to +6 points

Why first:

- It uses existing schema surface.
- It does not add API cost.
- It makes weak-agent reasoning explicit at the earliest decision point.

### 2. Preserve and copy upstream analysis signals into selects after triage

Impact: high  
Effort: medium, about 1-2 days  
Files:

- `runtime/commands/triage.ts` or the triage stage that finalizes selects
- `runtime/agents/llm-triage-agent.ts`
- tests around selects normalization/schema validation

Change:

- After the LLM chooses candidates, enrich each candidate deterministically from its source segment:
  - map `peak_analysis.peak_moments` to `editorial_signals.peak_type`, `peak_strength_score`, `peak_ref`, and `peak_source_pass`
  - map segment motion/audio measures, when present, to `peak_signals.motion`, `audio_rms`, `editorial_signals.motion_energy_score`, and `audio_energy_score`
  - map `visual_quality.scores.emotional_expression` to `editorial_signals.reaction_intensity_score` or `afterglow_score` only when labels support it
  - copy `visual_quality.labels.*` and selected tags into `editorial_signals.visual_tags`
  - assign `semantic_cluster_id` if cluster data exists or derive a stable coarse cluster from asset/motif tags
- Keep this pass deterministic and schema-safe. It should not invent story roles; it only carries measured or upstream-derived signals.

Expected score impact:

- `emotion_curve_alignment`: +10 to +20 points, because deterministic checks stop seeing `0/100` candidates with signals.
- `visual_variety_and_focus`: +5 to +12 points, especially if clusters become available.
- `pacing_coherence`: +3 to +8 points through motion/audio energy and trim hints.

Why second:

- It reduces reliance on the LLM prompt obeying every requested optional field.
- It reuses VLM/API work that has already been paid for.
- It improves deterministic scorer confidence.

### 3. Add minimal schema enrichment for story and pacing intent

Impact: medium-high  
Effort: medium, about 1 day for schema/types/tests after the intended fields are agreed  
Files:

- `schemas/selects-candidates.schema.json`
- artifact TypeScript types
- parser/normalizer tests
- fixture updates only where necessary

Change:

Add optional fields that are hard to represent cleanly today:

```yaml
story_role: hook | setup | experience | payoff | reaction | closing
emotion_tags:
  - wonder
  - discovery
pacing_role: hold | bridge | accent | texture_insert | release
brief_alignment:
  must_have_refs:
    - seasonal nature scenery
  emotion_curve_refs:
    - wonder
  rationale: "Establishes scale and calm before local detail."
```

Keep the fields optional so existing consumers do not break. Do not add runtime/eval metadata to creative artifacts; only add stable editorial intent fields that downstream planning can use.

Expected score impact:

- `narrative_structure`: +10 to +20 points
- `emotion_curve_alignment`: +5 to +12 points
- `pacing_coherence`: +5 to +10 points

Why not first:

- Existing fields are enough for an immediate improvement.
- Schema changes should follow one sprint of prompt/enrichment evidence, so the new fields reflect real usage rather than guesses.

### 4. Improve VLM summaries for tourism/editorial specificity

Impact: medium  
Effort: medium, about 1-2 days plus rerun cost  
Files:

- `runtime/connectors/gemini-vlm.ts`
- VLM normalization tests
- optionally analysis defaults if prompt/template version changes

Change:

- Keep the current concrete-summary requirement, but add editorial recognition instructions for:
  - place/landscape features
  - food/craft/action specificity
  - human scale in landscape
  - weather/season/time-of-day cues
  - camera vantage: aerial, close-up, wide, handheld, static
  - emotional readability and whether the shot can function as wonder, discovery, warmth, serenity, etc.
- Require `tags` to include both generic visual tags and specific subject/action tags.
- Add an optional `editorial_labels` or reuse `visual_quality.labels` if avoiding segment schema churn.

Expected score impact:

- `visual_variety_and_focus`: +8 to +15 points
- `emotion_curve_alignment`: +3 to +8 points
- `intent_message_alignment`: +3 to +6 points

Cost note:

- This increases value per VLM API call but may require rerunning analysis to update existing `segments.json`. Use cache/provenance and prompt hashes carefully.

### 5. Add selects-stage coverage gates and rerun feedback

Impact: high for reliability  
Effort: medium-deep, about 2-4 days depending on CLI integration  
Files:

- pipeline command/stage orchestration
- `runtime/eval/brief-alignment-*`
- triage coverage feedback path
- docs for thresholds

Change:

- Run brief-alignment immediately after selects generation.
- Gate progression to blueprint when hard thresholds fail:
  - `must_have_coverage < 0.9`: rerun triage with coverage feedback
  - `emotion_curve_alignment < 0.7`: require emotion/peak annotations or rerun
  - `narrative_structure < 0.7`: require story role coverage
  - `visual_variety_and_focus < 0.7`: require motif/cluster diversity
- Feed gaps into the existing `coverageFeedback` mechanism, but generalize it beyond must-have coverage.
- Keep gates warning-only at first; turn selected thresholds blocking after calibration on 3-5 projects.

Expected score impact:

- Less about single-run score lift; more about preventing low-evidence selects from entering blueprint.
- Expected stable selects score after rerun: 82-88%.

Why later:

- Gates are only useful after selects can actually satisfy them through prompt and enrichment changes.

## Implementation Roadmap

### Sprint 1: quick wins, about 1 day

Goal: improve artifact legibility without schema changes.

Work:

1. Update triage prompt output shape to require existing optional fields:
   - `eligible_beats`
   - `motif_tags`
   - richer `evidence`
   - `editorial_signals.visual_tags`
   - `editorial_signals.peak_type` / `peak_strength_score` when source peak exists
   - `trim_hint.preferred_duration_us` when clear
2. Update `selectsFromLlmResponse` to preserve these existing fields with schema-safe sanitizers.
3. Add tests proving optional fields survive parsing and invalid values are dropped.
4. Add selection-note guidance:
   - opening emotional intention
   - middle development intention
   - closing/release intention
   - rough pacing policy for selected material
5. Rerun `ena-promo` selects/brief-alignment and compare only the four weak axes.

Expected target after Sprint 1:

| Axis | Current | Sprint 1 target |
| --- | ---: | ---: |
| `emotion_curve_alignment` | 60% | 70-75% |
| `narrative_structure` | 60% | 68-72% |
| `pacing_coherence` | 70% | 73-76% |
| `visual_variety_and_focus` | 70% | 75-78% |
| Selects total | 74.5% | 79-82% |

### Sprint 2: schema enrichment plus deterministic post-triage annotation, about 2-3 days

Goal: make selects a durable editorial-intent contract, not only a better prompt response.

Work:

1. Implement deterministic post-triage enrichment from `segments.json` into existing optional fields:
   - peaks
   - visual tags
   - visual-quality-derived emotional/motion signals
   - cluster ids where available
2. Add optional schema fields only for gaps that existing fields cannot express clearly:
   - `story_role`
   - `emotion_tags`
   - `pacing_role`
   - possibly `brief_alignment`
3. Update triage parser/types to preserve the new fields.
4. Update brief-alignment deterministic checks so selects narrative/emotion/pacing can use the new fields before falling back to LLM judge.
5. Add fixtures that prove old selects still validate.

Expected target after Sprint 2:

| Axis | Current | Sprint 2 target |
| --- | ---: | ---: |
| `emotion_curve_alignment` | 60% | 78-85% |
| `narrative_structure` | 60% | 78-85% |
| `pacing_coherence` | 70% | 78-82% |
| `visual_variety_and_focus` | 70% | 80-85% |
| Selects total | 74.5% | 84-87% |

### Sprint 3: pipeline gates, about 1 week

Goal: make weak selects self-correct before blueprint/timeline work.

Work:

1. Add selects-stage brief-alignment check to the pipeline as a warning gate.
2. Convert brief-alignment gaps into structured triage feedback.
3. Add one automated rerun path for low coverage/alignment, capped to avoid loops.
4. Add project-level gate thresholds with conservative defaults.
5. Calibrate on `ena-promo`, `fumoto-growth`, and `togakushi-camp`.
6. Promote selected thresholds from warning to blocking only after calibration.

Expected target after Sprint 3:

| Axis | Current | Sprint 3 target |
| --- | ---: | ---: |
| `emotion_curve_alignment` | 60% | 82-88% |
| `narrative_structure` | 60% | 82-88% |
| `pacing_coherence` | 70% | 80-85% |
| `visual_variety_and_focus` | 70% | 82-88% |
| Selects total | 74.5% | 86-90% |
| Composite | 80.6% | 87-91% |

## Practical Priority Order

1. **Preserve richer optional fields from triage output.** Fastest path to visible score movement.
2. **Post-triage enrichment from existing analysis data.** Highest reliability gain because it does not depend on LLM obedience.
3. **Add small schema fields for story/pacing intent.** Do this only after Sprint 1 proves the exact fields are useful.
4. **Improve VLM summary specificity.** Valuable, but it costs API reruns and should be prompt-hash/provenance controlled.
5. **Add gates.** Important for system quality, but only after the artifact has enough structure to pass the gates.

## Success Criteria

### Artifact quality

- At least 80% of active candidates have one or more brief-relevant `motif_tags`.
- At least 70% of active candidates have explicit emotion or story-role evidence after Sprint 2.
- At least 70% of active candidates carry `editorial_signals` or `peak_signals` when source analysis has usable data.
- Generic evidence-only candidates are either upgraded with specific visual evidence or marked lower confidence with a risk.

### Eval movement

- Sprint 1: selects score reaches at least 79% on `ena-promo`.
- Sprint 2: selects score reaches at least 84% on `ena-promo`.
- Sprint 3: composite reaches at least 87% without lowering blueprint score.

### System behavior

- Old selects artifacts remain valid.
- New fields are optional and schema-safe.
- No eval-only metadata is written into creative artifacts.
- VLM API usage is not increased by triage prompt/parser changes.
- Pipeline gates produce actionable feedback, not just fail/pass labels.

## Non-goals

- Do not make selects duplicate the full blueprint.
- Do not solve perceived final-video rhythm at selects stage.
- Do not expand schemas with broad free-form objects that bypass validation.
- Do not use VLM for text/YAML artifact judging.
- Do not optimize solely for the LLM judge wording; improve the contract that downstream agents need anyway.

## Recommended First Change

Start with a narrow PR that changes only triage prompt/parser behavior:

- ask for richer metadata in existing fields
- preserve those fields
- add tests
- rerun `ena-promo` brief-alignment

This is the best impact/effort tradeoff because it directly addresses the judge gaps while respecting the current schema and cost architecture.
