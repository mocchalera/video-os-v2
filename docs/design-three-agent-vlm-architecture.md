# Design: Three-Agent VLM Architecture

## North Star

Use specialized weak agents behind strict artifacts:

- **Marlin = Reporter**: video-native local model that says what is physically happening in the footage.
- **Gemini = Appraiser**: image-native API model that judges one good frame for quality, OCR, place hints, and visual distinctiveness.
- **Claude/Codex = Editor**: text-native subscription agent that compares structured reports against the brief and makes editorial choices.

The design target is not "one smarter model." It is a pipeline where each model has a narrow job, every claim has provenance, and downstream agents make decisions from structured evidence instead of raw impressions.

## Current State Analysis

### Gemini VLM

The current Gemini VLM connector is a general segment-enrichment pass. Its prompt asks for `summary`, `tags`, `interest_points`, `quality_flags`, confidence, and `visual_quality` in one JSON response ([runtime/connectors/gemini-vlm.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/gemini-vlm.ts:24)). It accepts a bundle of frame paths plus text context through the provider-agnostic `VlmFn` interface ([runtime/connectors/gemini-vlm.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/gemini-vlm.ts:150)), normalizes quality flags and `visual_quality`, and defaults to `gemini-2.5-flash-lite` when no policy override is provided ([runtime/connectors/gemini-vlm.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/gemini-vlm.ts:652)).

The VLM stage groups segments by asset, skips unusable or too-short segments, runs Gemini with concurrency, and reduces successful shards back into `segments.json` and `assets.json` ([runtime/pipeline/stages/vlm.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/vlm.ts:237), [runtime/pipeline/stages/vlm.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/vlm.ts:363)). The reducer currently overwrites or enriches `summary`, `tags`, `quality_flags`, `interest_points`, `visual_quality`, confidence, and provenance ([runtime/pipeline/stages/vlm.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/vlm.ts:385)).

Failure mode: this pass asks Gemini flash-lite to be both reporter and appraiser. In recent Ena experiments, flash-lite plus small filmstrip imagery misidentified concrete subjects such as chestnuts, soba noodles, traditional craft, and grape vineyards as generic people holding objects. That poisons clustering and triage because the text summary becomes the evidence layer. Gemini is still useful, but not as the primary scene describer in this tier.

### Marlin

Marlin is already integrated as a local worker with two narrow calls: `caption(videoPath)` and `find(videoPath, event)` ([runtime/connectors/marlin-local.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/marlin-local.ts:38)). Its raw output shape includes `scene`, optional `caption`, and timestamped `events` ([runtime/connectors/marlin-types.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/marlin-types.ts:18)). The stage normalizes that into `03_analysis/marlin_events.json`, then applies overlapping events back to `segments.json` as `interest_points` and `peak_analysis` ([runtime/pipeline/stages/marlin.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/marlin.ts:122), [runtime/pipeline/stages/marlin.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/marlin.ts:174)).

The default policy already declares Marlin enabled, primary, and responsible for temporal semantics ([runtime/analysis-defaults.yaml](/Users/operator/Dev/video-os-v2-spec/runtime/analysis-defaults.yaml:44)). The CLI currently runs the normal ingest/VLM pipeline first, then runs Marlin as a post-pass when enabled ([scripts/analyze.ts](/Users/operator/Dev/video-os-v2-spec/scripts/analyze.ts:258), [scripts/analyze.ts](/Users/operator/Dev/video-os-v2-spec/scripts/analyze.ts:278)).

Failure mode: Marlin is strong at physical scene/action/temporal event reporting, but it is not the right tool for OCR, signage, exact place identification from outside knowledge, or aesthetic judgment from a high-resolution still. It also currently enriches peaks and interest points, not the canonical segment `summary` itself, so the pipeline has not fully promoted Marlin to primary reporter yet.

### Triage

The current LLM triage agent defaults to `gemini-2.5-flash-lite` ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:23)). It compacts `segments.json` into segment evidence containing summary, tags, peak evidence, transcript, filmstrip path, `visual_quality`, and interest-point labels ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:70), [runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:313)). In multimodal mode it prepares resized filmstrip images at 512 px width and sends them with the text prompt ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:176), [runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:703)).

The prompt already instructs the agent to prefer visual evidence over unreliable transcript text, cover `must_have`, respect the emotion curve, and reject technically unusable footage, including low `visual_quality` segments ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:432)).

Failure mode: editorial selection is text reasoning over structured artifacts, so using paid Gemini API for this stage is the wrong cost/quality tradeoff. The filmstrip path can help when segment summaries are weak, but it is also where flash-lite has shown poor subject recognition. Triage should consume Marlin plus Gemini-appraiser reports and run primarily as a Claude/Codex subscription-agent task. The Gemini runtime agent can remain as a headless fallback.

### Blueprint

The current blueprint agent is text-only and also defaults to `gemini-2.5-flash-lite` ([runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:24)). It compacts the brief and approved selects, then asks for an `EditBlueprint` JSON with beats, story arc, pacing, policies, candidate plans, and duration rules ([runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:157), [runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:218)). Its normalizer strips unknown fields, canonicalizes candidate refs, and fills defaults ([runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:765)).

Failure mode: blueprint planning does not need direct vision. It needs careful editorial reasoning over the brief and selected candidate evidence. That belongs to Claude/Codex, with the existing Gemini agent retained as fallback automation.

### Compile

Compile should stay deterministic: `edit_blueprint.yaml` plus `selects_candidates.yaml` become `timeline.json`. No model should be making hidden clip-placement decisions in compile. Model judgment belongs upstream in explicit artifacts and gates.

## Proposed Model Assignment

| Stage | Model | Input | Output |
| --- | --- | --- | --- |
| Scene description | Marlin-2B local | Raw video or bounded proxy clip | `scene`, segment `summary`, temporal `events`, event-derived `interest_points` |
| Temporal peak detection | Marlin-2B local, with deterministic overlap mapping | Raw video plus find queries, then segment windows | `peak_analysis`, recommended in/out, visual energy hints |
| Quality assessment | Gemini 2.5 Flash, Pro only for critical shots | One high-res representative frame per segment | `visual_quality.scores`, quality labels, appraiser confidence |
| Text/signage OCR | Gemini 2.5 Flash | Frames where text/signage is visible | `extracted_text`, language/script hints, confidence |
| Place identification | Gemini 2.5 Flash | Best frame plus Marlin scene description | `place_hint`, category, confidence, evidence |
| Triage selection | Claude/Codex subscription agent | Marlin report, Gemini appraiser report, brief, transcript snippets | `selects_candidates.yaml` |
| Blueprint planning | Claude/Codex subscription agent | Approved selects, brief, style/blockers | `edit_blueprint.yaml` |
| Compile | Deterministic TypeScript | Blueprint plus selects | `timeline.json` |
| Review/eval | Deterministic checks plus optional Claude/Codex text judge, optional VLM only for rendered visual checks | Artifacts or rendered samples | Reports and rerun feedback, not schema pollution |

## Data Flow Design

### Target Flow

1. **Foundation analysis** creates `assets.json`, initial `segments.json`, filmstrips, representative timestamps, transcript excerpts, and quality flags.
2. **Marlin reporter pass** reads raw video or the bounded Marlin proxy, writes `03_analysis/marlin_events.json`, and writes segment-level scene/temporal evidence into `segments.json`.
3. **Gemini appraiser pass** extracts one high-resolution frame for each eligible segment, receives the Marlin scene description as context, and writes only appraisal fields into the same segment.
4. **Evidence compactor** builds a triage payload that contains Marlin scene/action facts, Gemini quality/OCR/place facts, transcript quality, peaks, and brief context.
5. **Claude/Codex triage** writes `selects_candidates.yaml`. It should not reread videos or infer visual facts not present in the combined reports.
6. **Claude/Codex blueprint** writes `edit_blueprint.yaml` from approved selects and the brief.
7. **Compile** deterministically turns the plan into `timeline.json`.

### Marlin Into `segments.json`

This is already partly working. `runMarlinAnalysis` writes `marlin_events.json` and calls `applyMarlinEventsToSegments`, which maps asset-level Marlin events into overlapping segment `interest_points` and `peak_analysis` ([runtime/pipeline/stages/marlin.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/marlin.ts:164), [runtime/pipeline/stages/marlin.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/marlin.ts:196)). The next step is to make Marlin the owner of segment scene description:

- Build segment `summary` from the best overlapping Marlin event plus asset-level `scene` or `caption`.
- Keep `03_analysis/marlin_events.json` as the full temporal source of truth.
- Use `provenance.summary.method = "marlin_caption_events"` or equivalent when Marlin owns `summary`.
- Do not let the Gemini appraiser overwrite Marlin-owned `summary`.

### Gemini Appraiser Into `segments.json`

`segments.json` is a closed schema at both root and segment-item levels ([schemas/segments.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/segments.schema.json:6), [schemas/segments.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/segments.schema.json:27)). It already supports optional `visual_quality` with strict `scores` and `labels` ([schemas/segments.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/segments.schema.json:105), [schemas/segments.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/segments.schema.json:109)). It also has `provenance.visual_quality` but does not yet have provenance or confidence slots for OCR/place/appraiser notes ([schemas/segments.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/segments.schema.json:81)).

Recommended schema addition for Phase 2:

```json
{
  "visual_appraisal": {
    "frame_us": 1234567,
    "frame_path": "appraiser_frames/SEG_0001.jpg",
    "extracted_text": [
      {
        "text": "string",
        "language": "ja",
        "confidence": 0.86
      }
    ],
    "place_hint": {
      "name": "string or null",
      "category": "vineyard | restaurant | craft_studio | station | temple | unknown",
      "confidence": 0.72,
      "evidence": ["visible sign", "Marlin scene context"]
    },
    "aesthetic_notes": [
      "specific quality or weakness"
    ]
  }
}
```

Keep `visual_quality` as the canonical numeric quality subtree. Put OCR/place/notes under one optional `visual_appraisal` object to minimize top-level schema churn. Add `confidence.visual_appraisal` and `provenance.visual_appraisal` rather than separate provenance keys for every subfield. If downstream prompts need flatter names, flatten only in the compact triage evidence.

### Combined Evidence To Triage And Blueprint

The triage compactor already consumes `visual_quality`, peak evidence, transcripts, and filmstrip paths ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:280), [runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:346)). Phase 3 should extend that compact evidence with:

- `scene_report`: Marlin scene summary, best event, event confidence, and source pass.
- `visual_quality`: existing Gemini scores and labels.
- `extracted_text`: flattened strings plus confidence.
- `place_hint`: name/category/confidence/evidence.
- `aesthetic_notes`: short appraiser notes.
- `source_conflicts`: optional deterministic note when Marlin and Gemini disagree.

Blueprint should not need `segments.json` directly. It should receive approved selects containing enough `why_it_matches`, `evidence`, `eligible_beats`, `motif_tags`, and `editorial_signals` to plan the edit.

## Gemini Appraiser Pass Design

### Input

Use one high-resolution representative frame per segment, not a filmstrip.

Frame selection policy:

1. Prefer `peak_analysis.recommended_in_out` midpoint when Marlin found a strong event.
2. Else use `rep_frame_us` if present.
3. Else use segment midpoint.

Store extracted frames under `03_analysis/appraiser_frames/` with project-relative paths. Use a bounded width such as 1600 or 1920 px, not a tiny 512 px filmstrip. Cache by source file hash, segment id, frame timestamp, prompt hash, model snapshot, and output schema version.

### Prompt Scope

The prompt must explicitly avoid scene description:

```text
You are the visual appraiser, not the scene reporter.
Marlin has already described the scene/action. Use that text only as context.
Look at this single high-resolution frame and return JSON for:
1. technical/aesthetic quality,
2. readable text/signage,
3. place or category hints,
4. short notes that help an editor compare candidates.
If text or place cannot be read, return empty text and unknown place with low confidence.
Do not rewrite the segment summary.
```

Output shape:

```json
{
  "visual_quality": {
    "scores": {
      "light_quality": 0.0,
      "subject_prominence": 0.0,
      "emotional_expression": 0.0,
      "composition_score": 0.0,
      "motion_quality": 0.0
    },
    "labels": {
      "lighting_style": [],
      "composition_tags": [],
      "expression_tags": [],
      "motion_tags": []
    }
  },
  "visual_appraisal": {
    "extracted_text": [],
    "place_hint": {
      "name": null,
      "category": "unknown",
      "confidence": 0.0,
      "evidence": []
    },
    "aesthetic_notes": []
  }
}
```

### Model

Default to `gemini-2.5-flash` for the appraiser. Do not use flash-lite for this role. Use Pro only for release-critical shots, calibration sets, or cases where OCR/place evidence determines whether a must-have is covered.

### Cost Shape

This pass is one API call per eligible segment with one high-resolution frame. It should be much cheaper than asking Gemini to inspect multi-frame bundles and then asking Gemini again for triage/blueprint. It also gives Gemini the job it is better suited for: OCR, place hints, frame-level quality, and comparative visual appraisal.

## Implementation Roadmap

### Phase 1: Formalize Marlin As Primary Reporter

Goal: make the existing Marlin pass the source of scene/action truth.

Implementation work:

- Move or document Marlin as the primary semantic pass in `scripts/analyze.ts` and `runtime/commands/analyze.ts`.
- Update `applyMarlinEventsToSegments` behavior in a future code task so Marlin can populate `summary` and scene/event-derived tags, not only `interest_points` and `peak_analysis`.
- Preserve `marlin_events.json` as the full asset-level temporal artifact.
- Add provenance that clearly separates `summary` from `visual_quality`.
- Keep Gemini VLM summary writes disabled or demoted when Marlin evidence exists.

Acceptance:

- A segment with Marlin evidence has a concrete scene/action summary from Marlin.
- Gemini appraiser output cannot overwrite that summary.
- Existing `--skip-marlin`, cache, and validation behavior remain backward compatible.

### Phase 2: Add Gemini Appraiser Pass

Goal: create a second-eye visual pass that does quality/OCR/place, not scene description.

Implementation work:

- Add an appraiser policy block under analysis defaults with model, max frame width, output schema version, and retry rules.
- Add a frame extraction helper for one high-resolution representative frame per segment.
- Add a connector/stage such as `gemini-appraiser.ts` and `stages/appraiser.ts`.
- Extend `segments.schema.json` with optional `visual_appraisal`, `confidence.visual_appraisal`, and `provenance.visual_appraisal`.
- Reuse the existing `visual_quality` schema and normalizer where possible.
- Add `--skip-appraiser` or equivalent only if the stage is enabled by default.

Acceptance:

- Each eligible segment can receive `visual_quality` plus `visual_appraisal`.
- OCR/place outputs degrade to empty/unknown with low confidence rather than hallucinated certainty.
- Cached reruns preserve existing appraiser outputs when prompt/model/frame hash matches.

### Phase 3: Feed Combined Evidence To Triage

Goal: make selection depend on Marlin plus Gemini reports instead of raw filmstrip impressions.

Implementation work:

- Extend compact segment evidence with `scene_report`, `visual_appraisal`, OCR text, and place hints.
- Make filmstrip attachments optional debug support, not the default triage dependency.
- Strengthen reject rules around `visual_quality`, unreadable subject, and place/text mismatch.
- Copy deterministic source signals into existing select fields (`evidence`, `motif_tags`, `editorial_signals`, `trim_hint`) instead of expanding selects prematurely.

Acceptance:

- A triage prompt contains enough concrete visual facts to select without seeing video.
- Candidates cite both a visual fact and a brief-alignment reason.
- Technically weak material is either rejected or marked with explicit risk.

### Phase 4: Move Triage And Blueprint To Claude/Codex Agents

Goal: stop spending visual API budget on text-only editorial reasoning.

Implementation work:

- Treat the Gemini triage/blueprint agents as fallback headless automation, not the normal development/eval path.
- Define Claude/Codex prompt contracts for triage and blueprint using the same compact evidence and schema requirements.
- Keep JSON/YAML parsing, normalization, and validation deterministic in the repo.
- Keep compile deterministic and model-free.

Acceptance:

- Normal iteration uses Marlin local, Gemini appraiser API, Claude/Codex text reasoning, and deterministic compile.
- API spend is limited to visual appraiser calls and optional visual review calls.
- Triage/blueprint artifacts pass the same schemas regardless of which subscription agent produced them.

## Cost Analysis

### Current

- Gemini flash-lite VLM sees frame bundles and is asked to describe scenes, tag content, detect quality flags, and score visual quality.
- Gemini flash-lite triage may receive resized filmstrip attachments in batches.
- Gemini flash-lite blueprint handles text-only planning.
- The same API family is paying for visual perception and editorial reasoning, even when the latter is just text artifact work.

### Proposed

- Marlin local handles scene/action/temporal event reporting at zero API cost.
- Gemini 2.5 Flash handles one-frame appraiser calls for quality/OCR/place only.
- Claude/Codex handles triage and blueprint inside subscription-based text reasoning.
- Compile remains deterministic.

### Net

Expected result: lower API cost and higher quality. Cost drops because text-only triage/blueprint leave the Gemini API path, and Gemini visual calls shrink from broad frame-bundle scene interpretation to one focused high-resolution frame per segment. Quality improves because Marlin handles video-native scene/action recognition, Gemini handles image-native appraisal/OCR/place work, and Claude/Codex handles structured editorial reasoning.

## Practical Risks

- **Schema churn**: `segments.json` is closed. Add one optional `visual_appraisal` object instead of scattering appraiser fields.
- **Summary ownership**: once Marlin is primary, Gemini must not overwrite `summary`.
- **Place hallucination**: require `unknown` with low confidence unless signage/landmark evidence is visible.
- **Single-frame blind spots**: quality/OCR/place are frame-level judgments. Temporal action remains Marlin's job.
- **Agent drift**: Claude/Codex must be given compact evidence and schemas, not broad permission to invent visual facts.
- **Eval blind spots**: brief-alignment scores can look good while visual quality and continuity are poor. Add technical quality and continuity checks before treating eval scores as release gates.

## First 2-3 Sprint Plan

1. **Sprint 1**: Marlin primary reporter.
   Promote Marlin scene/event evidence into segment summaries and provenance. Keep Gemini VLM summary fallback only when Marlin has no evidence.

2. **Sprint 2**: Gemini appraiser.
   Add one-frame extraction, Gemini Flash appraiser prompt, `visual_appraisal` schema, cache/provenance, and strict low-confidence fallback behavior.

3. **Sprint 3**: Editorial routing.
   Extend triage compact evidence, run Claude/Codex triage/blueprint as the default workflow, keep Gemini agents as fallback, and add basic gates for technical quality plus scene continuity.

The build should stay small: no new grand orchestration layer, no model voting, no schema-free metadata. The pipeline should improve because each weak agent gets the evidence shape it can handle and the next stage sees explicit contracts instead of vague prose.
