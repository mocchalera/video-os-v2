# Design: Brief-Alignment Evaluation

## Problem statement

The current creative-regeneration eval is useful, but it optimizes the wrong thing if treated as the main quality target. `scripts/eval-regenerate.ts` explicitly measures how close a regenerated selection comes to a human selection, starting from a blind scratch project that contains `01_intent` and `03_analysis` but not the approved answer in `04_plan` or `05_timeline` ([scripts/eval-regenerate.ts](/Users/operator/Dev/video-os-v2-spec/scripts/eval-regenerate.ts:1), [scripts/eval-regenerate.ts](/Users/operator/Dev/video-os-v2-spec/scripts/eval-regenerate.ts:11)). The report then scores precision/recall/F1, role agreement, rank correlation, and beat-eligibility overlap against the human-approved selects ([runtime/eval/regenerate-report.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/regenerate-report.ts:99), [runtime/eval/regenerate-report.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/regenerate-report.ts:127)).

That is a good development sanity check. It catches regressions where the agent misses obvious human-approved moments, over-selects noise, or ignores known coverage expectations. It is not a good north-star metric because video editing is not a single-answer task. Two rough cuts can use different shots and still serve the same creator intent. Conversely, a cut can match many human-selected clips and still fail because the arc is flat, the ending does not land, or the pacing undermines the message.

The real goal is viewer impact: does the output move the intended audience toward the feeling, belief, or behavior described by the creator? That cannot be fully automated. The closest practical proxy is brief alignment: how well each artifact and final cut expresses the structured creative brief. This is especially compatible with the project principle that weak agents should produce quality through structure, contracts, and gates rather than model intelligence. The evaluator should reward contract-visible evidence of intent alignment and only use model judgment where the artifact cannot be checked deterministically.

## Available contract surface

The brief already contains enough structured intent to drive a first-pass scorer:

- Project strategy, title, runtime target, and strict/guide duration mode live under `project` ([schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:27), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:51)).
- Primary and secondary message are explicit under `message` ([schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:63)).
- Audience, emotion curve, order policy, caption policy, audio policy, `must_have`, and `must_avoid` are first-class fields ([schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:83), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:110), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:118), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:134), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:148)).
- Hypotheses, forbidden interpretations, content hints, and editorial channel/profile hints are optional but useful for rubric weighting ([schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:218), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:225), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:232), [schemas/creative-brief.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/creative-brief.schema.json:236)).

The selects artifact exposes the main evidence layer: selected candidate role, `why_it_matches`, risks, confidence, semantic rank, quality flags, evidence, `eligible_beats`, transcript excerpt, motif tags, and closed `editorial_signals` such as emotion/action/visual peak data and cluster IDs ([schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:89), [schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:130), [schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:158), [schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:169), [schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:176), [schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:211)).

The blueprint artifact exposes the intended edit shape: sequence goals, beats, story arc, quality targets, pacing, music/caption/dialogue/transition/ending policies, duration policy, and timeline order ([schemas/edit-blueprint.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json:27), [schemas/edit-blueprint.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json:35), [schemas/edit-blueprint.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json:68), [schemas/edit-blueprint.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json:116), [schemas/edit-blueprint.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json:329), [schemas/edit-blueprint.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json:520)).

The agents already consume this intent. Triage compacts the brief to title, strategy, runtime target, primary/secondary message, `must_have`, and `emotion_curve`, then instructs the model to cover must-haves, respect the emotion curve and chronology, maintain breadth, and include opening/ending ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:333), [runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:361)). Blueprint planning similarly compacts runtime/order/audio/caption policy, message, must-haves, emotion curve, and editorial hints, then requires beats to correspond to `story_arc` and use only approved candidate refs ([runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:157), [runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:218), [runtime/agents/llm-blueprint-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-blueprint-agent.ts:300)).

## Evaluation axes

Use six axes, each scored `0..1` with a short evidence list and failure notes. Keep the axis names stable so reports can be compared across projects.

| axis | what it checks | primary stage | practical scoring |
| --- | --- | --- | --- |
| `intent_message_alignment` | The selected moments and planned sequence clearly express the brief's primary message and do not drift into forbidden interpretations or must-avoid items. | selects, blueprint, timeline | LLM judge over brief + artifact summaries; deterministic must-avoid keyword/evidence checks where possible. |
| `must_have_coverage` | Every selectable must-have is represented with explicit evidence, while production directives are deferred to blueprint/timeline policy checks. | selects, blueprint, timeline | Reuse and extend `analyzeSelectionCoverage`, which already separates production directives from selection targets ([runtime/eval/selection-coverage.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/selection-coverage.ts:17), [runtime/eval/selection-coverage.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/selection-coverage.ts:301)). |
| `emotion_curve_alignment` | The artifact has an opening, development, peak/release, and ending that follow the brief's `emotion_curve`. | blueprint, timeline, final render | LLM judge over beat purposes and timeline clip motivations; VLM/render judge only for timeline/final validation. |
| `narrative_structure` | The cut has a legible hook/setup/experience/payoff/closing, causal progression, and brief-appropriate chronology/editorial ordering. | blueprint, timeline | Deterministic beat/story-role presence plus LLM judge over `story_arc`, beat order, and clip motivations. |
| `pacing_coherence` | Rhythm, duration, audio/caption policies, and cut density fit the channel, tone, runtime mode, and intended feeling. | blueprint, timeline, final render | Deterministic duration and policy checks plus LLM judge over timeline description; optionally use rendered output for perceived rhythm. |
| `visual_variety_and_focus` | The selection avoids monotony while preserving thematic unity, visual quality, subject clarity, and enough cluster coverage. | selects, timeline | Existing density/cluster coverage plus visual-quality signals from `segments.json` when available; prior research recommends axis-level VLM scores with evidence rather than a single aesthetic score ([docs/research-visual-quality-signals.md](/Users/operator/Dev/video-os-v2-spec/docs/research-visual-quality-signals.md:183), [docs/research-visual-quality-signals.md](/Users/operator/Dev/video-os-v2-spec/docs/research-visual-quality-signals.md:193)). |

Suggested weights for the first implementation:

```json
{
  "intent_message_alignment": 0.20,
  "must_have_coverage": 0.20,
  "emotion_curve_alignment": 0.20,
  "narrative_structure": 0.15,
  "pacing_coherence": 0.15,
  "visual_variety_and_focus": 0.10
}
```

Project normalization should be rubric-anchored, not corpus-relative. A `0.8` means "strongly serves this brief with minor gaps" regardless of project type. Axis weights can be adjusted by brief fields: for example, `duration_mode: strict` increases the duration component of `pacing_coherence`; `hook_priority: aggressive` increases first-15-second hook scrutiny; `order_policy: chronological` increases chronology penalties.

## Scoring architecture

### Stage coverage

Evaluate all stages, but do not use the same judge everywhere:

1. `selects`: score whether the candidate pool contains enough on-brief material. This is the cheapest and most actionable gate. It can catch missing must-haves, sparse coverage, role imbalance, repetitive clusters, and off-brief justifications before blueprint/timeline work starts.
2. `blueprint`: score whether the selected material has been organized into a coherent story and policy plan. This is where emotion curve, narrative structure, pacing intent, music/dialogue/ending policy, and duration policy become visible.
3. `timeline`: score whether the compiled result preserves the blueprint's intended arc and timing. This stage can use timeline IR descriptions initially, then rendered timeline review when available.
4. `final output`: reserve for calibration and release checks, not every inner-loop run. VLM-as-judge on rendered video is valuable for perceived emotion/rhythm, but it is slower and more expensive than artifact judging.

### Judge types

Use a hybrid scorer:

- Deterministic contract checks for anything the schema exposes directly: selected runtime, target duration, role distribution, must-have evidence, cluster coverage, missing beats, story role sequence, policy presence, timeline order, and must-avoid flags.
- LLM-as-judge for artifact-level editorial interpretation: "does this `why_it_matches` evidence actually support the primary message?", "does this beat sequence follow the emotional curve?", "does the ending feel resolved according to the brief?" These calls can be run by repo-side subscription agents where possible, because they are text/YAML artifact judgments rather than direct video understanding.
- VLM-as-judge only when the input is visual: filmstrips/contact sheets, rendered timeline slices, or final video. This matches the cost architecture: VLM remains API-only, while non-visual stages should use subscription agents or deterministic code.

There is already an optional LLM judge pattern in `runtime/eval/llm-judge.ts`; it skips gracefully without `GEMINI_API_KEY`, builds a brief + timeline prompt, and returns normalized scores plus rationale ([runtime/eval/llm-judge.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/llm-judge.ts:1), [runtime/eval/llm-judge.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/llm-judge.ts:55), [runtime/eval/llm-judge.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/llm-judge.ts:96), [runtime/eval/llm-judge.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/llm-judge.ts:118)). Brief-alignment should generalize this pattern, but remove the golden dependency from the prompt.

### Comparability and calibration

All axis scores should be normalized to `0..1`, with rubric anchors:

- `1.0`: fully aligned; any deviations are deliberate and supported by the brief.
- `0.8`: strong; minor gaps do not harm the intended viewer impact.
- `0.6`: usable rough cut; the intent is visible but one major axis is weak.
- `0.4`: structurally present but emotionally or narratively weak.
- `0.2`: mostly off-brief or missing essential evidence.
- `0.0`: unusable for this brief.

The score should include `confidence` and `judge_source` per axis. A deterministic score with full contract evidence can have high confidence. A text-only LLM score over sparse artifacts should report lower confidence. VLM scores should include the sampled render range or frame/contact-sheet IDs so failures can be reproduced.

### Relationship to existing eval

Brief-alignment complements the existing agreement eval; it should not replace it.

The current eval stack already supports stage-level normalized scores and optional judge contribution ([runtime/eval/types.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/types.ts:1), [runtime/eval/report.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/report.ts:11), [runtime/eval/index.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/index.ts:98)). Keep human-golden F1 as an engineer-facing regression signal:

- Use `eval-regenerate.ts` to answer: "did a change make the agent stop finding the kinds of moments humans previously valued?"
- Use brief-alignment to answer: "does this generated output serve the brief, even if it chooses different moments?"

The two reports should be displayed side by side for a while. A change is most interesting when alignment rises and F1 falls, because that may indicate valid alternative edits. A change is risky when F1 rises but alignment falls, because that suggests overfitting to past human selections.

## Implementation sketch

Add a new CLI, not in this task:

```bash
npx tsx scripts/eval-brief-alignment.ts --project projects/fumoto-growth
npx tsx scripts/eval-brief-alignment.ts --project reports/eval/regen-scratch/fumoto-growth --stage selects
npx tsx scripts/eval-brief-alignment.ts --project projects/fumoto-growth --render 05_timeline/render.mp4
```

Inputs:

- Required: `<project>/01_intent/creative_brief.yaml`.
- Optional by stage: `<project>/03_analysis/segments.json`, `<project>/04_plan/selects_candidates.yaml`, `<project>/04_plan/edit_blueprint.yaml`, `<project>/05_timeline/timeline.json`, rendered video path.
- Optional comparison context: human golden path, only for side-by-side reporting, not for the alignment score.

Output paths:

- `reports/eval/brief-alignment-<project>_<timestamp>.json`
- `reports/eval/brief-alignment-<project>_<timestamp>.md`

Proposed JSON shape:

```json
{
  "version": "1",
  "project": "fumoto-growth",
  "evaluated_at": "2026-06-17T00:00:00.000Z",
  "brief_hash": "sha256:...",
  "stages": {
    "selects": {
      "score": 0.78,
      "axes": {
        "intent_message_alignment": {
          "score": 0.82,
          "confidence": 0.72,
          "judge_source": "llm_artifact",
          "evidence": ["hero candidates explain the primary growth message"],
          "gaps": ["secondary audience is not explicitly addressed"]
        }
      }
    },
    "blueprint": {},
    "timeline": {},
    "final_output": {}
  },
  "composite": 0.81,
  "notes": ["Must-have coverage is strong; ending policy needs sharper payoff."]
}
```

Suggested implementation sequence for 1-2 sprints:

1. Define `BriefAlignmentReport` types under `runtime/eval` and a renderer parallel to `renderMarkdownReport`.
2. Implement deterministic `selects` scoring by reusing `analyzeSelectionCoverage` and adding must-avoid, evidence presence, role balance, and cluster/visual-variety checks.
3. Add an artifact LLM judge prompt for `selects` and `blueprint` that takes only the brief and current artifact, asks for the six axes, and requires JSON with evidence-backed scores. Use a subscription-agent path where available; use API fallback only if needed.
4. Add timeline IR text judging by adapting `describeTimeline` from `runtime/eval/llm-judge.ts` but removing the golden section.
5. Add optional VLM judging for rendered timeline slices or contact sheets after the artifact score is stable. Start with 3-5 sampled windows: opening, early development, midpoint/peak, closing, and any low-confidence beat.
6. Run the new report beside `eval-regenerate.ts --score` on existing projects and record disagreements for calibration.

Composite scoring:

- Compute each stage score as the weighted average of available axes.
- Compute overall as `selects 0.30`, `blueprint 0.25`, `timeline 0.30`, `final_output 0.15`, renormalized over present stages.
- Apply caps for hard failures: if selectable must-have coverage is below `0.5`, cap composite at `0.65`; if `must_avoid` is violated with high confidence, cap at `0.5`; if no clear opening or ending exists, cap timeline score at `0.7`.

Model routing:

- Deterministic checks: local TypeScript only.
- Text/YAML artifact judge: subscription agent preferred, because the task is structured reasoning over artifacts and does not need video input.
- VLM judge: API only, preferably low-cost multimodal for contact sheets and stronger model only for final rendered clips that affect release decisions.

## Validating the scorer

Brief-alignment scoring itself needs validation. Do not treat model scores as truth.

Use three calibration loops:

1. Human editorial review set: collect 10-20 rough cuts across project types. Have a human rate the same six axes on `0..1` using the same anchors. Measure rank correlation and inspect disagreements.
2. Known perturbations: generate controlled bad variants, such as removing must-have candidates, shuffling chronology when `order_policy` is chronological, flattening the ending, duplicating one visual cluster, or replacing hero candidates with texture. The score should drop on the intended axis.
3. Existing agreement comparison: run brief-alignment beside `eval-regenerate.ts`. Useful cases are alignment-high/F1-low and alignment-low/F1-high. These become regression fixtures and prompt/rubric examples.

Minimum acceptance for the first version:

- The report is deterministic except for explicit judge calls.
- Every axis score has evidence and gaps, not just a number.
- The scorer never requires a human golden to produce an alignment score.
- Missing optional artifacts degrade to partial-stage scoring rather than failure.
- The output can be used as a gate: "do not compile timeline if selects alignment is below threshold" or "request another triage pass if must-have/variety gaps remain."

## Contract and schema guidance

Do not expand the closed canonical schemas just to store eval state. `selects-candidates.schema.json` is closed at both top level and candidate level ([schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:297), [schemas/selects-candidates.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:360)). The evaluator should write separate report artifacts under `reports/eval`, not mutate `selects_candidates.yaml`, `edit_blueprint.yaml`, or `timeline.json`.

For visual quality, follow the prior research direction: enrich `segments.json` with optional segment-local `visual_quality` and project-relative signals before trying to add new fields to selects. The research already recommends preserving existing `summary`, `tags`, `interest_points`, and `quality_flags`, adding optional `visual_quality`, and normalizing scores with confidence and evidence ([docs/research-visual-quality-signals.md](/Users/operator/Dev/video-os-v2-spec/docs/research-visual-quality-signals.md:259), [docs/research-visual-quality-signals.md](/Users/operator/Dev/video-os-v2-spec/docs/research-visual-quality-signals.md:263)).

Keep runtime/control metadata out of schema-validated creative artifacts. Coverage feedback already reaches triage as runtime context rather than being written into selects, and the selection guide already gives the weak agent a structured checklist ([runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:300), [runtime/agents/llm-triage-agent.ts](/Users/operator/Dev/video-os-v2-spec/runtime/agents/llm-triage-agent.ts:347)). Brief-alignment should use the same pattern: reports and gates can steer reruns, but canonical artifacts stay focused on creative decisions.

## Recommended first build

Build the first version as `scripts/eval-brief-alignment.ts --project <dir> --stage selects,blueprint` with no rendered video dependency.

Scope:

- Deterministic checks for `must_have_coverage`, selectable production-directive handling, density/cluster variety, target duration, and policy presence.
- One structured text judge call for selects and one for blueprint, using the six stable axes and requiring short evidence/gaps.
- Markdown + JSON report under `reports/eval`.
- Side-by-side optional section that links to the latest `eval-regenerate.ts` report when present, but never uses human F1 in the alignment composite.

This is practical in 1-2 sprints because it builds on `runtime/eval/selection-coverage.ts`, `runtime/eval/report.ts`, `runtime/eval/llm-judge.ts`, and the existing agent prompt compactors. It also matches the north star: the evaluator does not assume the model "knows good editing"; it turns the brief into explicit checks, axis rubrics, evidence requirements, and gates that make weak agents behave more like disciplined assistants.
