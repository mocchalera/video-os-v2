# Design: Simplified Two-Model Pipeline

> Date: 2026-06-18
> Status: Draft
> Scope: Design and migration plan for replacing the current multi-agent editorial pipeline with a two-model architecture
> Non-goal: No runtime, schema, project artifact, or external service changes in this document task
> Related: [design-three-agent-vlm-architecture.md](./design-three-agent-vlm-architecture.md), [design-editorial-craft-agent-first.md](./design-editorial-craft-agent-first.md), [design-editorial-craft-structure-first.md](./design-editorial-craft-structure-first.md)

## 1. Architecture Overview

The simplified architecture keeps the project north star: weak agents plus structure equals quality. The change is that the editorial decisions are no longer split across five separate model stages. The system keeps one local video-native model for seeing, one subscription editor for deciding, and deterministic code for execution.

Target flow:

```text
1. Marlin-2B local
   raw video -> scene descriptions + temporal events

2. Claude/Codex subscription
   brief + Marlin reports + key frames + BGM duration -> all editorial decisions

3. Compile deterministic
   editorial plan -> timeline.json

4. Render ffmpeg
   timeline.json -> rough-cut.mp4

5. Marlin-2B local
   rough-cut.mp4 -> structured QA report

6. Claude/Codex subscription
   QA report + original brief + prior decisions -> revised editorial decisions
   loop back to compile
```

### Marlin = Eyes

Marlin is the video-native perception layer. It runs locally, has no per-run API cost, and owns the facts about what is visible over time.

Pre-edit responsibilities:

- Read raw source video or bounded proxy clips.
- Produce scene descriptions for each asset and segment.
- Produce temporal events with start/end times, descriptions, and confidence.
- Surface action boundaries, visual peaks, reaction moments, and usable trim anchors.
- Populate or support existing analysis fields such as scene summaries, `interest_points`, `peak_analysis`, and trim evidence.

Post-edit responsibilities:

- Watch the rendered `rough-cut.mp4`.
- Report what the viewer sees scene by scene.
- Identify pacing, continuity, visual quality, and emotional-arc issues in the output.
- Produce a structured QA report for Claude/Codex to revise the editorial plan.

Marlin does not decide the story, pick the edit, choose the final structure, or rewrite the brief. It provides grounded observations.

### Claude/Codex = Brain

Claude/Codex is the editorial decision layer. In the normal operator path it runs inside the existing subscription environment, not as a per-call external API dependency.

Inputs:

- Creative brief and any human notes.
- Marlin scene descriptions and temporal events.
- Key frames extracted by ffmpeg, typically 2-5 frames per candidate clip.
- BGM duration and available rhythm metadata.
- Prior QA feedback when running an improvement loop.
- Existing schema requirements for `selects_candidates.yaml` and `edit_blueprint.yaml`.

Outputs:

- Candidate selection with roles, story roles, rationale, risks, confidence, and evidence.
- Beat structure with candidate plans and craft directives.
- Per-clip in/out points or trim hints, with rationale tied to specific Marlin events.
- Transition choices and fallback intent.
- Pacing, rhythm, BGM, dialogue, caption, and ending policies.

The key design point: there are no intermediate model artifacts between selection, blueprinting, craft, and clip trimming. Claude/Codex emits one structured editorial decision bundle, and the repo immediately normalizes that into the existing canonical artifacts.

### Compile = Hands

Compile stays deterministic. It receives `selects_candidates.yaml`, `edit_blueprint.yaml`, and related existing plan artifacts, then produces `timeline.json`.

Compile must not call a model, infer hidden taste decisions, inspect raw media for new facts, or silently override the editorial plan. It validates and executes explicit structure.

### Render = Output

Render stays ffmpeg-based. It receives `timeline.json` and source media, then produces `rough-cut.mp4` and any existing preview/delivery outputs.

### External API = None

The normal path has no additional external API cost:

- Marlin is local.
- Claude/Codex runs through the subscription agent workflow.
- Compile is local deterministic code.
- Render is local ffmpeg.

Gemini becomes an optional fallback for headless or CI environments where subscription-agent access is unavailable. It is not part of the default architecture.

### Design Assumptions And Constraints

- The normal editorial path uses Claude/Codex through a subscription agent surface. If a future implementation calls Anthropic, OpenAI, or Gemini through per-token APIs, that is no longer the zero-additional-cost path.
- Marlin QA is a local output-evaluation pass. It should be calibrated against real rough cuts before becoming a hard release gate.
- Key frames are local files extracted by ffmpeg. They are evidence for the Claude/Codex pass, not new canonical artifacts.
- The first implementation keeps all existing schemas and artifact names unchanged.
- Gemini fallback must be explicit, opt-in, and provenance-visible.

## 2. Comparison With Current Architecture

### Removed Or Merged

| Current stage | New home | Reason |
| --- | --- | --- |
| Gemini appraiser | Merged into Claude/Codex editorial pass, with key frames and Marlin reports as input | The normal path avoids external API calls. Claude/Codex can judge quality from key frames plus Marlin evidence when operating interactively. Gemini remains fallback only. |
| Gemini triage agent | Merged into Claude/Codex editorial pass | Selection is editorial reasoning over evidence, not a separate API stage. |
| Gemini blueprint agent | Merged into Claude/Codex editorial pass | Structure, beat planning, pacing, and policies are the same editorial decision, not a separate model handoff. |
| Craft agent | Merged into Claude/Codex editorial pass | Craft choices should be made while selecting and sequencing, not after a draft blueprint already exists. |
| Clip-trim-agent | Merged into Claude/Codex editorial pass, with deterministic fallback/validation available | In/out decisions are part of choosing the moment. The model cites Marlin events; compile validates and clamps. |

### What Stays

| Component | Status | Notes |
| --- | --- | --- |
| Marlin-2B | Stays, expanded role | Still local and video-native. It now handles both pre-edit perception and post-render QA. |
| Compile | Stays unchanged in principle | Deterministic execution from existing schemas into `timeline.json`. |
| Render | Stays unchanged | ffmpeg remains the output engine. |
| Schemas and contracts | Stay unchanged | The unified pass maps to existing `selects_candidates.yaml`, `edit_blueprint.yaml`, `uncertainty_register.yaml`, and `timeline.json` contracts. |
| Gemini-based agents | Stay as fallback | They remain useful for headless automation, CI, or environments without subscription-agent access. |

The practical migration is not "delete the old pipeline first." It is "add the unified editorial pass, prove it produces the same canonical artifacts, then demote the older stages to fallback."

## 3. Unified Editorial Pass

The unified editorial pass replaces triage, blueprint, craft review, and clip trimming with one Claude/Codex reasoning pass. It should feel closer to a human editor reviewing the material: see the available moments, judge quality, pick what matters, decide the arc, choose the cut points, and specify how the edit should move.

### Inputs

Required inputs:

- `01_intent/creative_brief.yaml`
- Marlin asset and segment reports:
  - scene descriptions
  - temporal events
  - event confidence
  - action/reaction boundaries
  - peak or interest-point evidence
- Key frames extracted by ffmpeg:
  - 2-5 per candidate clip or segment
  - frame timestamp and path
  - preferably event-boundary, peak, midpoint, and end-hold frames
- BGM duration:
  - `bgm_duration_sec` or equivalent
  - available beat/downbeat metadata when already analyzed
- Current schema snippets or field rules for selects and blueprint.

Optional inputs:

- Prior `review_metrics.json`, `review_report.yaml`, or human notes.
- Previous Marlin QA report when this is loop iteration 2 or later.
- Existing successful artifacts from a prior iteration.

The pass must distinguish observed facts from editorial judgment:

- Observed fact: "Marlin event `evt_004` shows a customer smiling from 3.2s to 5.1s."
- Key-frame judgment: "Frame at 4.0s has readable expression and strong subject prominence."
- Editorial decision: "Use this as the payoff candidate and hold after the smile."

### Output Shape

The model output is a transient `unified_editorial_decision` object. It is not a new canonical artifact unless a future implementation explicitly adds a debug sidecar. The command normalizes it immediately into existing artifacts.

Illustrative shape:

```yaml
version: 1
project_id: example-project
editorial_strategy:
  summary: Open with action, build through proof, resolve with afterglow.
  pacing: mixed
  bgm_duration_sec: 58.4
  qa_feedback_addressed:
    - previous pacing issue if this is an iteration

selects:
  selection_notes:
    - Covers all must-have items with concrete visual evidence.
    - Uses fast support cuts in the middle and slower holds at the end.
  candidates:
    - candidate_ref: seg_a_001_3200000_5100000
      segment_id: seg_a_001
      asset_id: asset_a
      src_in_us: 3200000
      src_out_us: 5100000
      role: hero
      story_role: payoff
      why_it_matches: Customer reaction resolves the brief's trust arc.
      risks: []
      confidence: 0.86
      evidence:
        - Marlin evt_004: customer smiles and nods from 3.2s to 5.1s.
        - Key frame 4.0s: face is readable and centered.
      eligible_beats: [b03_payoff, b04_closing]
      motif_tags: [human_reaction, trust_signal]
      editorial_signals:
        peak_type: emotional_peak
        peak_strength_score: 0.82
      trim_hint:
        recommended_in_us: 3200000
        recommended_out_us: 5100000
        preferred_duration_us: 1900000
        peak_ref: evt_004
        peak_type: emotional_peak
        rationale: Enter before the smile and hold through the nod.

blueprint:
  sequence_goals:
    - Hook with visible action before explanation.
    - Build proof through process and reaction.
    - Resolve on a warm human moment.
  beats:
    - id: b01_hook
      label: Immediate action
      purpose: Establish motion and reason to watch.
      target_duration_frames: 96
      required_roles: [hero]
      preferred_roles: [support, texture]
      story_role: hook
      candidate_plan:
        primary_candidate_ref: seg_b_002_1200000_3600000
        fallback_candidate_refs: [seg_c_003_900000_2800000]
      craft:
        in_point: cut_on_action
        out_point: peak_hold
        rhythm: accelerando
        transition_out: hard_cut
        beat_sync: true
  pacing:
    opening_cadence: brisk
    middle_cadence: varied
    ending_cadence: resolved
    default_duration_target_sec: 58.4
  transition_policy:
    allow_hard_cuts: true
    prefer_match_texture_over_flashy_fx: true
    avoid_speed_ramps: true
  duration_policy:
    mode: guide
    source: explicit_brief
    target_source: explicit_brief
    target_duration_sec: 58.4
    min_duration_sec: 48
    max_duration_sec: 65
    hard_gate: false
    protect_vlm_peaks: true

revision_notes:
  - If QA found repeated same-location shots, alternate process and reaction beats.
  - If BGM is shorter than target runtime, cap the edit at BGM duration or fade early.
```

### Normalization Targets

The transient output maps to existing artifacts:

- `selects.candidates[]` -> `04_plan/selects_candidates.yaml`
- `blueprint.*` -> `04_plan/edit_blueprint.yaml`
- unresolved decisions -> `04_plan/uncertainty_register.yaml`
- revision notes -> optional operator-visible log or Markdown trace, not a compile dependency

This preserves the existing contracts while removing model-to-model handoffs.

### Required Editorial Decisions

The pass must make these decisions in one response:

- Which segments are selected, rejected, or held as fallbacks.
- What role each selected clip serves: `hero`, `support`, `transition`, `texture`, or `dialogue`.
- What story role each clip serves: hook, setup, experience, payoff, reaction, or closing.
- Which beats exist and why they are ordered that way.
- Which candidates fill each beat.
- Where each clip should start and end, with Marlin event references when available.
- Which transitions should connect beats or clips.
- How pacing should change across opening, middle, and ending.
- How BGM duration constrains target duration and cut rhythm.
- Which risks should remain visible rather than hidden.

### Guardrails

The unified pass must not:

- Invent visual facts not present in Marlin reports or key frames.
- Emit candidates outside the provided source segments.
- Add fields that fail existing schemas.
- Mutate `timeline.json`.
- Call ffmpeg or shell commands.
- Treat Gemini as required for normal operation.
- Hide uncertainty. If evidence is missing, write an uncertainty or lower confidence.

## 4. Marlin Output QA

After render, Marlin becomes the output evaluator. It watches the actual rough cut rather than the source pool.

Input:

- `05_timeline/rough-cut.mp4` or the current rendered preview path.
- Optional timeline metadata for timestamp mapping, if available.
- Optional brief summary for context, if Marlin QA prompt support can use it.

Marlin QA report responsibilities:

- Scene-by-scene description of what the viewer sees.
- Pacing assessment:
  - cuts too fast to read
  - holds too long
  - abrupt rhythm changes
  - long dead zones
- Continuity issues:
  - repeated same scene without progression
  - spatially disconnected adjacent shots
  - action appears to jump backward or reset
  - same subject or location appears in a confusing order
- Visual quality issues:
  - dark or overexposed sections
  - blur, severe shake, blocked subject, unreadable frames
  - low-value texture that lasts too long
- Emotional arc assessment:
  - whether the edit appears to build, peak, and resolve
  - whether the ending has a recognizable final moment
  - whether the opening creates immediate subject/action clarity

Illustrative QA shape:

```yaml
version: 1
project_id: example-project
render_path: 05_timeline/rough-cut.mp4
qa_model: marlin-2b
overall:
  pass: false
  confidence: 0.74
  summary: The edit is clear but the middle repeats similar process shots and the ending cuts away before the reaction resolves.
scene_observations:
  - qa_scene_id: q01
    start_us: 0
    end_us: 3800000
    description: Fast opening action, hands begin a process, subject readable.
    perceived_role: hook
    quality_flags: []
  - qa_scene_id: q02
    start_us: 3800000
    end_us: 11800000
    description: Similar workbench/process shots repeat with little visual change.
    perceived_role: proof
    quality_flags: [repetition]
pacing:
  verdict: needs_revision
  issues:
    - start_us: 3800000
      end_us: 11800000
      severity: medium
      issue: Three similar process shots run back to back and slow the middle.
      suggested_revision_intent: Replace one process shot with a reaction or place-setting shot.
continuity:
  issues:
    - start_us: 18200000
      end_us: 22000000
      severity: medium
      issue: Same location appears after an unrelated location without a bridge.
visual_quality:
  issues:
    - start_us: 26100000
      end_us: 28400000
      severity: high
      issue: Subject is dark and hard to read during a long hold.
emotional_arc:
  verdict: partial
  issue: Ending contains a reaction moment but cuts before the nod finishes.
  suggested_revision_intent: Extend final reaction by 12-24 frames or choose a clearer closing candidate.
```

Marlin QA should not patch artifacts directly. It reports what it sees and where the output fails. Claude/Codex decides the revision.

## 5. Improvement Loop

The loop is intentionally simple:

1. Marlin watches `rough-cut.mp4` and writes structured QA feedback.
2. Claude/Codex reads the original brief, prior unified decision, canonical artifacts, and Marlin QA report.
3. Claude/Codex emits a revised unified editorial decision.
4. The repo normalizes the decision into existing selects and blueprint artifacts.
5. Compile regenerates `timeline.json`.
6. Render regenerates `rough-cut.mp4`.
7. Marlin QA runs again.
8. Stop when QA passes, the operator accepts the result, or max iterations is reached.

Recommended loop controls:

- Default max iterations: 2 automatic revision loops after the first render.
- Stop early when QA has no high-severity issues and at most one medium issue.
- Escalate to human/operator when the same issue appears twice.
- Preserve a revision trace outside canonical schemas, such as logs or an optional Markdown report.
- Never let QA feedback pollute `selects_candidates.yaml` or `edit_blueprint.yaml` with non-schema fields.

Revision prompt requirements:

- Cite the QA issue being addressed.
- Preserve strengths from the previous render.
- Make the smallest editorial change that addresses the issue.
- Do not churn all candidates unless QA shows a structural failure.
- Keep duration and BGM constraints explicit.

## 6. Cost Analysis

### Current Cost Shape

The current architecture can spend external API calls on:

- VLM scene interpretation.
- Gemini appraiser.
- Gemini triage.
- Gemini blueprint.
- Gemini or fallback craft review.
- Optional multimodal retries or repair calls.

The expensive pattern is not only one large call. It is model-stage multiplication: each editorial handoff creates another prompt, another parse/repair path, another retry surface, and another chance to pay for text reasoning that could have happened in the subscription editor.

### New Cost Shape

The target default path has zero additional external API cost:

- Marlin local: free per run after local setup.
- Claude/Codex subscription: no additional per-project API spend in the normal operator workflow.
- Compile: free deterministic local code.
- Render: free local ffmpeg.
- Marlin QA: free local inference.

Gemini remains optional fallback only:

- Headless CI without Claude/Codex subscription access.
- Batch automation where the operator explicitly accepts API spend.
- Emergency fallback when local key-frame inspection is not available.

### Policy

Default policy:

- Do not require Gemini for normal development, eval, or iteration.
- Do not use Gemini for text-only editorial reasoning by default.
- Do not use Gemini appraiser as a required stage.
- If a fallback uses Gemini, it must be explicit in logs and artifact provenance.

## 7. Implementation Roadmap

### Phase 1: Unified Editorial Pass

Goal: replace triage, blueprint, craft, and clip trimming with one Claude/Codex pass while producing the same canonical artifacts.

Work:

- Define the transient unified editorial decision contract.
- Build the prompt around brief, Marlin reports, key frames, BGM duration, and schema requirements.
- Normalize output into existing `selects_candidates.yaml` and `edit_blueprint.yaml`.
- Keep `uncertainty_register.yaml` for unresolved decisions.
- Validate both artifacts with existing schemas.
- Keep old triage, blueprint, craft, and clip-trim stages callable as fallback.

Acceptance:

- One Claude/Codex pass can produce schema-valid selects and blueprint artifacts.
- Candidates cite Marlin events or key-frame evidence.
- Beat craft, transitions, pacing, and in/out intent are present where useful.
- Compile receives the same artifact types it receives today.
- Existing projects can still run the old pipeline.

### Phase 2: Marlin Output QA

Goal: evaluate the rendered rough cut with the same local video-native model.

Work:

- Add a post-render Marlin QA prompt or mode for rendered outputs.
- Normalize QA observations into a structured report.
- Map QA timestamps to timeline clip ids when timeline metadata is available.
- Add severity levels and pass/fail criteria.
- Keep the report separate from canonical plan artifacts.

Acceptance:

- QA report describes the rendered cut scene by scene.
- QA identifies pacing, continuity, visual quality, and emotional-arc issues.
- The report is concise enough for Claude/Codex to use directly in revision.
- Missing or uncertain judgments are marked as low confidence rather than treated as hard failures.

### Phase 3: Improvement Loop

Goal: close the loop from QA feedback to revised editorial decisions.

Work:

- Feed Marlin QA report into the unified editorial pass.
- Require revisions to cite QA issues and preserve prior strengths.
- Recompile and re-render after each revision.
- Stop on QA pass, human accept, or max iterations.
- Detect stagnation when the same issue repeats.

Acceptance:

- A failed QA issue can be traced to a specific revised select, beat, trim, transition, or pacing decision.
- Revisions do not randomly rewrite the entire edit.
- Compile and render remain deterministic.
- Max-iteration behavior leaves an actionable report for the operator.

### Phase 4: Deprecate Gemini-Dependent Stages

Goal: keep Gemini paths available but no longer default.

Work:

- Mark Gemini appraiser, Gemini triage, Gemini blueprint, and Gemini craft paths as fallback/headless.
- Update docs and operator help to prefer the two-model path.
- Keep tests that prove fallback outputs still normalize to the same schemas.
- Add visible provenance when fallback is used.

Acceptance:

- Normal workflow uses Marlin, Claude/Codex, compile, render, and Marlin QA.
- CI/headless can still run with Gemini fallback when explicitly enabled.
- No existing project artifact becomes unreadable.

## 8. Migration Strategy

Migration must be additive and reversible.

### Additive First

- Add the unified editorial pass beside the existing stages.
- Do not remove current commands in the first implementation.
- Do not change canonical artifact names.
- Do not change schemas for Phase 1.
- Do not require existing projects to regenerate analysis.

### Feature Flag

Use an explicit mode switch, for example:

```text
VOS_EDITORIAL_PIPELINE=unified
VOS_EDITORIAL_PIPELINE=legacy
VOS_EDITORIAL_PIPELINE=gemini-fallback
```

Recommended rollout:

- Default to `legacy` until the unified pass has fixture coverage.
- Allow project-local opt-in to `unified`.
- Use `gemini-fallback` only for headless environments or explicit API-spend runs.
- Record the selected mode in logs and optional run reports.

### Compatibility

The two-model path must read and write the same canonical surfaces:

- Reads `creative_brief.yaml`, Marlin reports, key frames, BGM metadata, and previous QA feedback.
- Writes `selects_candidates.yaml`, `edit_blueprint.yaml`, and `uncertainty_register.yaml`.
- Lets compile write `timeline.json`.
- Lets render write `rough-cut.mp4`.
- Lets QA write a report outside canonical plan artifacts.

### Rollback

Rollback is command routing, not artifact migration:

- Switch the feature flag back to `legacy`.
- Keep any unified pass debug reports as ignored context.
- Rerun old triage and blueprint stages from the same analysis artifacts.
- Compile and render continue to consume the same schema-valid plan files.

### Practical Risks

- Claude/Codex may overfit to a single edit direction.
  - Mitigation: require confidence, risks, and uncertainty entries.
- Key frames may miss temporal action.
  - Mitigation: Marlin event references are required for in/out decisions when available.
- Marlin QA may over-report subjective pacing.
  - Mitigation: use severity, confidence, max iteration limits, and human accept.
- Unified output may be too large.
  - Mitigation: chunk source evidence but keep the final editorial decision single and normalized.
- Schema pressure may return.
  - Mitigation: map to existing fields first; add schemas only after repeated evidence shows a real need.

## 9. Reliability, Safety, And Observability

Reliability requirements:

- Identical normalized artifacts must compile to identical `timeline.json` output.
- Unified pass parsing must fail closed before promoting invalid selects or blueprint artifacts.
- Missing key frames, missing BGM analysis, or low-confidence Marlin QA must degrade to uncertainty or warnings, not invented facts.
- Fallback Gemini stages must produce the same canonical artifact types as the unified path.

Safety requirements:

- Prompts must not receive API keys, secrets, or arbitrary filesystem authority.
- Model outputs must not be treated as shell, ffmpeg, or Remotion commands.
- The model must not mutate `timeline.json` or rendered media directly.
- Any visual claim in a selected candidate should cite Marlin evidence or a key-frame reference.

Observability requirements:

- Each run should log the selected pipeline mode: `unified`, `legacy`, or `gemini-fallback`.
- Unified decisions should record input artifact hashes or timestamps in a non-canonical trace.
- QA reports should preserve timestamps, severity, confidence, and whether the issue was addressed in the next iteration.
- Fallback use should be visible in logs and optional run reports so API spend is auditable.

## 10. Acceptance Criteria

The design is ready to implement when:

- The unified pass is defined as one editorial model call, not five chained model calls.
- Normal operation has no required Gemini or other per-run external API dependency.
- The pass can produce both selects and blueprint artifacts without changing schemas.
- Per-clip trims cite Marlin events or explicitly fall back to authored ranges.
- Render QA is local Marlin analysis of the actual output video.
- QA feedback loops back through Claude/Codex as revised editorial decisions.
- Legacy stages remain available behind a feature flag.
- Compile and render remain deterministic and model-free.

## 11. Summary

The simplified pipeline is:

- Marlin sees the source footage.
- Claude/Codex makes all editorial decisions at once.
- Compile executes the plan deterministically.
- Render produces the rough cut.
- Marlin sees the rough cut.
- Claude/Codex revises the plan if QA fails.

This removes model-stage fragmentation without abandoning structure. The quality bet is still weak agents plus strict artifacts. The difference is that the editor's job is no longer split into appraiser, triage, blueprint, craft, and trim agents. Claude/Codex does that editorial thinking in one pass, while Marlin supplies local video-native evidence before and after the edit.
