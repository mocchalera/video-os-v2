# Design: Editorial Craft Agent First

> Date: 2026-06-18
> Status: Draft
> Scope: Design and implementation plan for a text-first editorial craft agent in the planning loop
> Non-goal: No runtime, schema, MCP, or project artifact changes in this document task
> Related: [docs/design-three-agent-vlm-architecture.md](/Users/operator/Dev/video-os-v2-spec/docs/design-three-agent-vlm-architecture.md), [docs/design-brief-alignment-eval.md](/Users/operator/Dev/video-os-v2-spec/docs/design-brief-alignment-eval.md), [docs/improvement-plan-brief-alignment.md](/Users/operator/Dev/video-os-v2-spec/docs/improvement-plan-brief-alignment.md)

## 1. Problem

The current pipeline is getting better at factual evidence:

- Marlin owns scene/action/temporal reporting.
- Gemini appraiser adds narrow quality, OCR, place, and aesthetic signals.
- Triage compacts that evidence into `selects_candidates.yaml`.
- Blueprint turns selected candidates into `edit_blueprint.yaml`.
- Compile remains deterministic.
- Review emits `review_report.yaml`, `review_patch.json`, and `review_metrics.json`.

That split is correct, but it still leaves a craft gap. A schema-valid rough cut can cover the brief, contain good candidates, and compile cleanly while still feeling flat: the hook may be technically present but not gripping, the middle may repeat the same visual grammar, the emotional release may arrive too early, or the ending may explain instead of landing.

Today, much of that craft judgment arrives late through `roughcut-critic` and review metrics after `timeline.json` already exists. Late critique is useful, but it creates avoidable churn: compile, preview, critique, patch, and recompile. The proposal here is to move the first serious editorial craft pass earlier, while the system is still planning.

## 2. North Star

Make editorial craft a first-class text reasoning stage before deterministic compile.

The craft agent is not a smarter VLM and not a second compiler. It is a text-first editor that reads structured evidence and asks: "If these are the available moments and this is the intended viewer impact, what sequence will actually feel edited?"

The rule remains:

- Perception belongs to Marlin and Gemini appraiser.
- Selection belongs to triage.
- Craft shaping belongs to the editorial craft agent.
- Mechanical assembly belongs to deterministic compile.
- Post-compile critique belongs to review metrics and roughcut critic.

## 3. Success Conditions

The design is successful when an implementation can meet these conditions:

1. A draft blueprint can receive an editorial craft review before promotion.
2. Accepted craft changes are reflected only through schema-valid `edit_blueprint.yaml` and `uncertainty_register.yaml` updates.
3. The craft agent cannot create, edit, or request direct edits to `timeline.json`.
4. Every craft issue cites an existing brief field, beat id, candidate id/ref, or evidence field.
5. Missing evidence creates uncertainty or lower confidence instead of invented visual facts.
6. Existing compile and review flows still work when the craft pass returns `accept`.
7. Repeated post-compile review failures can be fed back into a later craft pass without polluting canonical artifacts.
8. The feature can be disabled by skipping the craft pass and promoting the original blueprint draft.

## 4. Current Surface

### 4.1 Evidence And Selection

The three-agent VLM design already establishes the evidence split: Marlin reports what happens, Gemini appraises a representative frame, and Claude/Codex handles normal editorial reasoning over the resulting artifacts. The current triage contract can already carry useful craft signals in `selects_candidates.yaml`, including:

- `story_role`
- `eligible_beats`
- `motif_tags`
- `editorial_signals`
- `peak_signals`
- `trim_hint`
- `evidence`

Recent brief-alignment work also made triage richer and more schema-safe: the runtime can copy `peak_analysis`, `visual_quality`, semantic clusters, and technical rejection signals from `segments.json` into existing select fields without widening the selects schema.

### 4.2 Blueprint

`blueprint-planner` currently transforms a validated brief plus selects into:

- `04_plan/edit_blueprint.yaml`
- `04_plan/uncertainty_register.yaml`

It owns sequence goals, beats, pacing, music, dialogue, transitions, ending policy, and uncertainty handling. This is the natural place for craft decisions to become executable because compile already consumes blueprint plus selects.

### 4.3 Compile

Compile should remain model-free. It should translate `edit_blueprint.yaml` and `selects_candidates.yaml` into `timeline.json` without hidden taste decisions. If a model wants a longer hold, a sharper contrast, an audio-led transition, or a different ending candidate, that intent must be explicit before compile.

### 4.4 Review

The review command already has two complementary surfaces:

- `roughcut-critic` emits `review_report.yaml` and `review_patch.json`.
- `review_metrics.json` captures deterministic checks across emotion, story, rhythm, eye trace, 2D plane, and audio.

Those should stay as the post-compile safety net. The craft agent should reduce preventable review failures, not replace review.

## 5. Proposed Agent

### 5.1 Name

`editorial-craft-agent`

### 5.2 Responsibility

The agent turns a candidate pool and draft blueprint into an edit-shaping decision. It focuses on:

- Hook force
- Emotional progression
- Beat contrast
- Motif economy
- Shot-duration intent
- Visual and audio rhythm
- Eye-trace continuity
- Ending shape
- Where ambiguity should block, branch, or be tolerated

It must not:

- Inspect raw media directly.
- Rewrite segment summaries.
- Add unsupported visual facts.
- Emit ffmpeg, Remotion, or shell commands.
- Mutate `timeline.json`.
- Invent candidates outside `selects_candidates.yaml`.
- Treat one possible edit as the only valid edit when multiple directions fit the brief.

### 5.3 Inputs

Required:

- `01_intent/creative_brief.yaml`
- `04_plan/selects_candidates.yaml`
- Draft `04_plan/edit_blueprint.yaml`
- Draft `04_plan/uncertainty_register.yaml`

Optional:

- Compact segment evidence from `03_analysis/segments.json`, especially `scene_report`, `visual_quality`, `visual_appraisal`, `peak_analysis`, and transcript reliability.
- `00_project/editorial_preference_memory.jsonl` when available.
- `06_review/review_metrics.json` from a previous iteration.
- `06_review/review_report.yaml` and `06_review/review_patch.json` from a previous iteration.
- Human notes from `06_review/human_notes.yaml`.

The first implementation should not require optional inputs. Missing optional inputs should lower confidence or create an uncertainty entry, not fail the stage.

### 5.4 Outputs

Phase 1 should avoid canonical schema churn.

The agent should return an internal structured decision:

```json
{
  "status": "accept | revise | block",
  "summary": "short craft judgment",
  "blueprint_edits": [
    {
      "target": "beats[2].purpose",
      "action": "replace",
      "reason": "middle beat repeats the same proof point as the previous beat"
    }
  ],
  "uncertainties": [
    {
      "type": "craft",
      "question": "Does the ending need a quiet memory beat or a concrete CTA?",
      "status": "requires_operator_decision"
    }
  ],
  "compile_hints": [
    "Hold the opening hero long enough to read the action before cutting to texture.",
    "Do not place two same-location support clips back to back unless one is audio-led."
  ],
  "reselect_requests": [
    {
      "reason": "No closing candidate carries afterglow or payoff evidence.",
      "requested_story_role": "closing"
    }
  ]
}
```

Persisted effects:

- Apply accepted changes into the draft `edit_blueprint.yaml` using existing blueprint fields.
- Apply unresolved craft questions into the existing `uncertainty_register.yaml`.
- Optionally write a human-readable sidecar at `04_plan/editorial_craft_review.md` for traceability.

The sidecar is useful but should not become a compile dependency in Sprint 1.

## 6. Placement In The Workflow

Target flow:

1. `/triage` produces schema-valid `selects_candidates.yaml`.
2. `/blueprint` produces draft `edit_blueprint.yaml` and `uncertainty_register.yaml`.
3. `editorial-craft-agent` reviews the draft blueprint against the brief and selects.
4. If accepted, the blueprint is promoted as usual.
5. If revised, the blueprint draft is updated and revalidated.
6. If blocked, the uncertainty register records the blocker and the project state stays planning-blocked.
7. `/review` compiles, previews, runs QC/metrics, and invokes roughcut critique as today.

This makes craft a pre-compile planning gate without letting the agent assemble the timeline.

## 7. Craft Rubric

The craft agent should use stable rubric axes so decisions can be compared across projects and mapped to review metrics later.

| Axis | Question | Existing evidence | Output destination |
| --- | --- | --- | --- |
| `hook_force` | Does the first beat create immediate reason to keep watching? | brief hook priority, hero candidates, peak signals, candidate confidence | opening beat purpose, candidate plan, pacing notes |
| `emotional_progression` | Does the sequence move through the brief's intended feeling curve? | brief emotion curve, `story_role`, peaks, `visual_quality.emotional_expression` | beat order, story arc, uncertainty register |
| `beat_contrast` | Do adjacent beats create contrast instead of repetition? | motif tags, semantic clusters, source assets, candidate roles | beat candidate choices, transition policy |
| `shot_duration_intent` | Which moments need holds, accents, or texture cuts? | `trim_hint`, source duration, motion/audio energy | pacing, beat target duration, candidate plan |
| `motif_economy` | Are motifs repeated with purpose rather than clutter? | motif tags, visual tags, semantic clusters | sequence goals, rejection rules |
| `eye_trace_and_plane` | Will adjacent shots feel spatially readable? | continuity refs, adjacency analysis, same-asset grouping | transition policy, candidate ordering constraints |
| `audio_story` | Does dialogue, natural sound, and music support the arc? | transcripts, audio story refs, audio policy | dialogue policy, music policy, audio notes |
| `ending_memory` | Does the last beat leave the intended residue? | closing candidates, afterglow/payoff signals, brief CTA/message | ending policy, closing beat |

The agent should always separate:

- Factual mismatch: evidence contradicts the brief or blueprint.
- Craft weakness: the plan is valid but weak.
- Taste alternative: more than one good direction is possible.
- Missing evidence: the agent cannot decide from available artifacts.

## 8. Prompt Contract

The first implementation can use a prompt contract rather than a new schema. The contract should require:

```text
You are the Editorial Craft Agent.

You read structured artifacts only. Do not inspect media directly.
Do not invent visual facts that are not present in the provided evidence.
Do not emit commands and do not mutate timeline.json.

Judge the draft blueprint against the brief and selects.
Focus on craft: hook, emotional progression, beat contrast, pacing, motif economy,
eye trace, audio story, and ending memory.

Return JSON with:
- status: accept | revise | block
- summary
- strengths
- craft_issues
- blueprint_edits
- uncertainty_updates
- compile_hints
- reselect_requests

Every issue must cite an artifact field, candidate id/ref, beat id, or brief field.
When multiple good directions exist, present alternatives rather than pretending
there is one correct edit.
```

The normalizer should reject:

- References to nonexistent candidate ids.
- Requests to mutate `timeline.json`.
- Raw commands.
- New visual facts not tied to segment/select evidence.
- Blueprint edits outside schema-known fields.

## 9. Interface Guidance

### 9.1 No New Canonical Schema In Sprint 1

Sprint 1 should treat the craft decision as command-internal data plus optional Markdown trace. The persisted creative contract remains:

- `selects_candidates.yaml`
- `edit_blueprint.yaml`
- `uncertainty_register.yaml`

This keeps the work compatible with current validators and avoids broad schema churn.

### 9.2 Schema-Safe Blueprint Edits

The craft pass should prefer existing blueprint surfaces:

- `sequence_goals`
- `beats[].purpose`
- `beats[].candidate_plan`
- `beats[].required_roles`
- `story_arc`
- `quality_targets`
- `pacing`
- `music_policy`
- `dialogue_policy`
- `transition_policy`
- `ending_policy`
- `rejection_rules`

If the agent needs a concept that does not fit, it should put the issue into `uncertainty_register.yaml` or the optional Markdown sidecar rather than adding ad hoc fields.

### 9.3 Relationship To Review Metrics

Review metrics should remain post-compile and deterministic. The craft agent should read previous metrics when available, but not write metrics directly.

Mapping:

- `hook_force` and `emotional_progression` should reduce later `emotion.*` warnings.
- `shot_duration_intent` should reduce later `rhythm.*` warnings.
- `beat_contrast` and `motif_economy` should reduce later `plane_2d.motif_overuse`.
- `eye_trace_and_plane` should reduce later adjacency warnings.
- `audio_story` should reduce later `audio.speech_cut` warnings.

This gives the project a useful loop: agent expresses craft intent, compiler executes it, metrics verify it, critic explains failures.

## 10. Non-Functional Requirements

### 10.1 Reliability

- Craft decisions must be normalized and validated before any blueprint draft is updated.
- Unknown blueprint targets, nonexistent candidates, malformed JSON, or unsupported operations must fail closed.
- Draft writes should use the existing draft-and-promote pattern so invalid craft revisions do not corrupt canonical artifacts.
- Missing optional inputs must degrade to warnings, confidence reductions, or uncertainty entries.

### 10.2 Safety And Security

- The craft agent must not receive API keys, raw credentials, or arbitrary filesystem authority.
- The prompt and normalizer must reject shell commands, ffmpeg commands, Remotion code, and direct timeline mutations.
- The agent must cite provided artifact evidence for all visual or audio claims; uncited claims are treated as speculation.
- Human notes and preference memory should be treated as local project context, not training data or external telemetry.

### 10.3 Performance And Cost

- The default pass should be text-only and should not call VLM APIs.
- Context should be compacted to brief, selects, draft blueprint, uncertainty register, and only the optional prior-review summaries needed for the decision.
- The pass should run once per blueprint draft by default. Reruns should require a changed input hash or an explicit operator request.

### 10.4 Observability

- Logs should record craft status, input artifact hashes, number of accepted edits, number of blocked uncertainties, and whether optional prior review context was used.
- The optional Markdown sidecar should summarize strengths, craft issues, accepted blueprint changes, unresolved uncertainties, and reselect requests.
- Post-compile review should be able to compare the craft decision against later `review_metrics.json` and `review_report.yaml` failures.

## 11. Implementation Plan

### Sprint 1: Prompted Craft Review Before Blueprint Promotion

Goal: add the craft pass without schema changes.

Work:

- Add an `editorial-craft-agent` role definition mirroring the guardrails of `blueprint-planner` and `roughcut-critic`.
- Add a command-internal `CraftDecision` type.
- Run the craft pass after blueprint draft generation and before promotion.
- Apply accepted schema-safe blueprint edits to the draft.
- Append unresolved issues to `uncertainty_register.yaml`.
- Optionally write `04_plan/editorial_craft_review.md`.
- Add tests for accept, revise, block, invalid candidate refs, and invalid blueprint targets.

Acceptance:

- Existing blueprint schemas still validate.
- Compile behavior is unchanged for an accepted blueprint.
- A blocked craft decision prevents promotion and records an actionable uncertainty.
- The agent cannot create or modify `timeline.json`.

### Sprint 2: Feedback From Previous Review

Goal: make craft review improve reruns.

Work:

- Feed previous `review_metrics.json`, `review_report.yaml`, and `review_patch.json` into the craft context when present.
- Teach the prompt to preserve resolved strengths and address unresolved review failures.
- Add stagnation detection so repeated craft passes do not keep proposing the same ineffective change.
- Add report rendering that shows which prior metric failures were addressed.

Acceptance:

- A rerun after review can trace each major previous warning to a new blueprint decision, accepted risk, or unresolved blocker.
- If the same issue appears twice, the agent escalates rather than silently repeating.

### Sprint 3: Deterministic Craft Gates

Goal: promote high-confidence craft checks into deterministic planning warnings.

Work:

- Convert frequent craft issues into local checks where the data is reliable.
- Keep interpretive judgments in the agent.
- Add optional warning-only preflight before compile for obvious craft failures: missing closing story role, no peak candidate in hook, repeated same semantic cluster across adjacent beats, and missing audio policy for dialogue-heavy cuts.

Acceptance:

- Deterministic checks explain obvious failures without replacing the agent.
- Warnings can guide another craft pass.
- No eval or feedback state pollutes canonical artifacts.

## 12. Validation Strategy

Use fixtures and real projects.

Minimum checks:

- Unit tests for `CraftDecision` normalization.
- Schema validation for revised `edit_blueprint.yaml` and `uncertainty_register.yaml`.
- Regression test that compile output is unchanged when the craft pass returns `accept`.
- Regression test that invalid craft edits are rejected before promotion.
- Fixture test where a known weak blueprint is revised toward better hook, contrast, and ending policy.
- Full command verification with `npx tsc --noEmit`, focused tests, then the repo's standard verify command.

Manual calibration:

- Run on at least three existing projects: one documentary/growth cut, one tourism/promo cut, and one dialogue-heavy cut.
- Compare pre-craft and post-craft `review_metrics.json`.
- Inspect whether post-compile `review_patch.json` shrinks in count or severity.
- Keep human judgment in the loop for whether the edit actually feels better.

## 13. Risks

### Over-Editing The Blueprint

The agent may make the blueprint verbose or overconstrained. Mitigation: cap edits to fields compile already uses, require each edit to cite evidence, and prefer uncertainty entries for speculative taste.

### False Single Truth

The agent may collapse multiple viable edits into one confident answer. Mitigation: prompt for alternatives when directions are genuinely equivalent and require confidence to reflect evidence quality.

### Schema Drift

The agent may request fields the current blueprint schema does not support. Mitigation: reject unknown targets and store unresolved concepts in the uncertainty register or Markdown sidecar.

### Late Metrics Still Fail

The craft pass cannot guarantee the rendered cut feels right. Mitigation: keep review metrics and roughcut critic as mandatory post-compile checks.

### Text-Only Blind Spots

The agent cannot see the video. Mitigation: it must rely on Marlin/Gemini evidence and mark missing visual evidence as uncertainty instead of guessing.

## 14. Rollback

The feature should be easy to disable:

- Skip the craft pass and promote the original blueprint draft.
- Ignore `04_plan/editorial_craft_review.md` if present.
- Keep compile and review paths unchanged.
- Keep any future deterministic craft checks warning-only until calibrated.

Because the first sprint avoids schema changes, rollback should be a command-routing change rather than an artifact migration.

## 15. Open Questions

1. Should the first implementation run as a separate `/craft` command or as an internal `/blueprint` gate?
   - Recommendation: internal `/blueprint` gate first. Add a separate command only if operators need to rerun craft without regenerating the blueprint.

2. Should `editorial_craft_review.md` be required?
   - Recommendation: optional in Sprint 1. It is useful for traceability but should not block compile.

3. Should the agent revise selects?
   - Recommendation: no direct selects mutation. It may emit `reselect_requests`; `/triage` owns candidate changes.

4. Should craft checks become release gates?
   - Recommendation: not initially. Treat them as planning warnings until they correlate with human review and post-compile metrics.

## 16. Summary

The editorial craft agent should be the first serious taste pass, not the last rescue pass. It gives the system a place to express why an edit should hold, cut, contrast, breathe, or resolve before deterministic compile locks those choices into `timeline.json`.

The practical path is small: add a text-only craft review between draft blueprint and blueprint promotion, write only schema-safe blueprint and uncertainty changes, keep compile deterministic, and use review metrics plus roughcut critic to measure whether the early craft pass actually reduced later failures.
