# Design: Editorial Craft Structure First

> Date: 2026-06-18
> Status: Draft
> Scope: Structure-first design for making editorial craft executable by the deterministic compiler
> Non-goal: No runtime, schema, MCP, or project artifact changes in this document task
> Companion: [docs/design-editorial-craft-agent-first.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/design-editorial-craft-agent-first.md)
> Related: [docs/cut-transition-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/cut-transition-design.md), [docs/vlm-peak-detection-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/vlm-peak-detection-design.md), [docs/milestone-4.5-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4.5-design.md)

## 1. Position

The agent-first design asks where editorial judgment should happen. This design asks what shape that judgment must take once it enters the deterministic pipeline.

The answer is: editorial craft should become a closed, typed vocabulary in the blueprint. The agent may choose the vocabulary value, but the compiler must own execution. "Hold the reaction longer" is not a compiler contract. `in_out.technique: post_action_hold` with a bounded hold, evidence anchor, fallback, and confidence gate can be.

Structure-first means:

- Craft is expressed as schema-valid directives, not prose instructions.
- Each directive maps to deterministic compiler behavior.
- Unsupported or under-evidenced craft degrades predictably.
- The compiler remains model-free.
- Review can inspect whether the requested craft was executed.

The practical target is a future `beats[].craft` object in `edit_blueprint.yaml`. The current schema does not yet allow this field, so implementation starts as an additive schema extension rather than a hidden convention in `notes`.

## 2. Current Compiler Surface

The compiler already has several craft-adjacent mechanisms:

- Blueprint beats define `target_duration_frames`, `required_roles`, `preferred_roles`, `story_role`, `candidate_plan`, `continuity_constraint`, and `skill_hints`.
- Blueprint-level policy defines `pacing`, `music_policy`, `dialogue_policy`, `transition_policy`, `active_editing_skills`, `trim_policy`, `duration_policy`, `timeline_order`, and `track_layout`.
- Select candidates can carry `trim_hint`, `editorial_signals`, `peak_signals`, `motif_tags`, `quality_flags`, `eligible_beats`, and candidate refs.
- `scoreCandidates()` deterministically ranks candidates using semantic rank, duration fit, quality penalties, motif reuse, adjacency penalty, active skill effects, peak salience, peak priority, and BGM-aware bonuses.
- `assemble()` turns ranked candidates into V1/V2/A1/A2 placement under strict or guide duration policy.
- `applyAdaptiveTrim()` resolves in/out points from `trim_hint`, peak type, preferred duration, and trim policy.
- `applyUtteranceSnap()` can move clip boundaries to transcript utterance edges when `talking_head_pacing` is active.
- `adjacencyDecide()` evaluates adjacent V1 pairs using transition skill cards, pair evidence, Murch-axis scores, BGM snap distance, and fallbacks.
- `applyBeatSnap()` retimes adjacent clips to commit beat-snapped cuts while preserving pair duration.

That is enough to make a structure-first design realistic. The missing layer is not a new taste engine. It is a normalized craft directive layer that tells these phases which rule to apply, with which anchor and fallback.

## 3. Craft Vocabulary As Schema

The compiler needs small, closed vocabularies. Each value must answer four questions:

1. What evidence can prove this technique is viable?
2. Which compiler phase executes it?
3. What timeline fields can it change?
4. What happens when evidence is missing?

### 3.1 In/Out Point Techniques

These directives affect `src_in_us`, `src_out_us`, clip duration, and trim metadata. They execute after candidate placement and before final constraint resolution.

| Technique | Evidence anchor | Compiler behavior | Degrade path |
| --- | --- | --- | --- |
| `cut_on_action` | Marlin temporal event, `trim_hint.peak_type: action_peak`, `editorial_signals.peak_type: action_peak`, or action-like `peak_signals` | Center the trim around the action event, favor enough pre-roll to read anticipation, and place the outgoing/incoming boundary near action motion rather than a static midpoint. | Fall back to `adaptive_peak_center`; if no peak/event exists, use `fixed_authored`. |
| `peak_hold` | `trim_hint.source_center_us`, `trim_hint.peak_ref`, `editorial_signals.peak_strength_score`, visual or emotional peak type | Protect the peak from duration compression, choose a preferred duration around the peak, and emit `metadata.editorial.peak` provenance. | Use `adaptive_center`; if confidence is below threshold, leave authored trim. |
| `pre_roll_enter` | Action start, utterance start, reveal start, or Marlin event boundary | Shift the trim window earlier than the center so the viewer enters before the event lands. | Clamp to `window_start_us`; if no start event exists, use normal peak-centered trim. |
| `post_action_hold` | Action end, reaction event, `afterglow_score`, silence ratio, emotional peak | Bias post-roll after the peak or utterance to preserve reaction, afterglow, or breath. | Clamp to `window_end_us`; if duration is strict, cap the hold and emit degraded metadata. |
| `clean_in_clean_out` | Transcript utterance edges, silence spans, event boundaries, technical quality flags | Snap boundaries away from mid-speech and mid-action interiors; prefer authored clean edges when no better event exists. | Use utterance snap when transcripts exist; otherwise keep authored range and warn if evidence is missing. |

The existing `trim.ts` already has most of the needed primitive behavior: peak-centered trim, peak-type asymmetry, authored-window clamps, and utterance-boundary snapping. The schema layer should make the chosen technique explicit instead of inferring it only from `peak_type` and active skills.

### 3.2 Transition Techniques

These directives affect `timeline.transitions[]`, pair retiming, and transition metadata. They execute in adjacency analysis after V1 clip order is known.

| Technique | Current primitive | Evidence anchor | Compiler behavior | Degrade path |
| --- | --- | --- | --- | --- |
| `hard_cut` | `transition_type: cut` | Energy contrast, action peak, semantic turn, BGM beat/downbeat | Emit a clean cut, optionally beat-snap the cut frame. Maps naturally to `smash_cut_energy` or `build_to_peak`. | Keep plain `cut` with `degraded_from_skill_id` if skill score is below threshold. |
| `dissolve` | `transition_type: crossfade` | Topic shift, time passage, low action energy, B-roll bridge | Emit crossfade with bounded overlap, usually snapped by transition center. Maps to `crossfade_bridge`. | Fall back to `cut` when action energy or viability gates reject dissolve. |
| `dip_to_black` | `transition_type: fade_to_black` | Ending, chapter break, silence, afterglow, emotional release | Emit fade-to-black with crossfade window and downbeat/center snap. Maps to `silence_beat`. | Fall back to short dissolve or cut, depending on duration mode. |
| `j_cut` | `transition_type: j_cut` | Incoming dialogue or natural sound should lead the next visual | Start incoming audio before incoming picture while keeping visual cut clean. | Deferred until audio overlap IR is implemented; until then emit uncertainty or lower to `dissolve`/`hard_cut`. |
| `l_cut` | `transition_type: l_cut` | Outgoing line, room tone, or reaction should carry over next visual | Continue outgoing audio under the next visual for reaction or continuity. | Deferred until audio overlap IR is implemented; until then emit uncertainty or lower to `dissolve`/`hard_cut`. |
| `match_cut` | `transition_type: match_cut` | Visual tag overlap, composition match, shot scale continuity, semantic cluster change | Emit match cut when pair evidence passes visual-similarity and story-change gates. Maps to `match_cut_bridge`. | Fall back to `crossfade` then `cut`. |

The existing transition skill system is the right execution model: skill cards provide `when`, `avoid_when`, `minimum_viable`, `fallback_order`, `pipeline_effects`, score threshold, and Murch weights. A `craft.transition_to_next.technique` should select or bias eligible transition cards, not bypass them.

### 3.3 Rhythm Patterns

Rhythm directives affect beat durations, candidate duration preference, cut placement, and beat snapping. They should remain bounded because rhythm can easily become under-specified prose.

| Pattern | Compiler rule | BGM interaction | Limit |
| --- | --- | --- | --- |
| `accelerando` | Later shots or beats become shorter, energy and peak priority increase, and hard cuts become more eligible. | Prefer increasingly close beat/downbeat alignment as the sequence builds. | Current beat-linear IR can handle beat-level duration shaping; within-beat shot subdivision needs later IR. |
| `ritardando` | Later shots or beats become longer, post-roll increases, and afterglow candidates become more eligible. | Prefer downbeat or section-boundary landing for release. | Must respect `duration_policy` and final duration cap. |
| `steady` | Keep shot durations near beat targets and avoid large duration variance. | Snap only when within tolerance; avoid over-retiming. | Useful as default and safest in strict duration mode. |
| `syncopated` | Place selected cuts deliberately off the obvious grid or alternate short/long durations. | Requires beat phase or offbeat targets, not just beat/downbeat arrays. | P1/P2 feature; current BGM data can warn but not fully execute. |
| `breath` | Preserve silence, phrase edges, and reaction holds; avoid wall-to-wall speech. | Land releases on downbeats when available, but do not destroy natural breath to chase the grid. | Works today through dialogue policy, utterance snap, `silence_beat`, and `post_action_hold` style trim. |

The BGM detector currently provides `beats_sec`, `downbeats_sec`, sections, BPM, meter, and readiness status. Structure-first rhythm should use only ready BGM analysis. If BGM analysis is partial or absent, rhythm directives should execute from durations and evidence scores only.

### 3.4 Shot Scale Rules

Shot scale directives affect candidate ordering, transition eligibility, and adjacency warnings. They should consume `adjacency_features.shot_scale`, composition fields, and visual quality confidence from segment/select evidence.

| Rule | Compiler rule | Evidence | Degrade path |
| --- | --- | --- | --- |
| `wide_to_close` | Prefer a scale progression from establishing context to detail or emotion. Penalize close shots before context unless the beat is a hook or deliberate disruption. | `shot_scale`, `composition_anchor`, story role, semantic cluster | If shot scale is unknown, do not force order; emit diagnostic. |
| `close_to_wide` | Start intimate or detail-first, then expand to reveal place, stakes, or consequence. | `shot_scale`, reveal/action events, story role | If no wide candidate exists, keep best candidate and record unmet preference. |
| `scale_match` | Prefer adjacent shots with same or neighboring scale when the cut is meant to be smooth. | `shot_scale_continuity_score`, `composition_match_score`, visual tag overlap | If match score is low, avoid `match_cut` and lower to dissolve or hard cut. |

`transition-skill-loader.ts` already computes shot scale continuity and composition match for transition decisions. The craft schema should expose when the blueprint intentionally wants scale movement versus scale continuity.

## 4. Blueprint Beat-Level Craft Directives

The proposed extension is `beats[].craft`. It is beat-local but may describe the transition out of the beat because adjacency is pair-based.

Example:

```yaml
beats:
  - id: beat_01_hook
    label: Immediate proof
    story_role: hook
    target_duration_frames: 96
    required_roles: [hero]
    preferred_roles: [support]
    craft:
      in_out:
        technique: cut_on_action
        anchor: action_peak
        min_confidence: 0.55
        pre_roll_frames: 8
        post_roll_frames: 4
        fallback: peak_hold
      rhythm:
        pattern: accelerando
        max_shot_length_frames: 48
        snap_to_bgm: beat
      shot_scale:
        rule: wide_to_close
        min_confidence: 0.50
      transition_to_next:
        technique: hard_cut
        snap_to_bgm: downbeat
        preferred_skill: smash_cut_energy
        fallback: dissolve
```

A compact schema fragment:

```json
{
  "$defs": {
    "beatCraft": {
      "type": "object",
      "properties": {
        "in_out": {
          "type": "object",
          "properties": {
            "technique": {
              "type": "string",
              "enum": ["cut_on_action", "peak_hold", "pre_roll_enter", "post_action_hold", "clean_in_clean_out"]
            },
            "anchor": {
              "type": "string",
              "enum": ["action_peak", "emotional_peak", "visual_peak", "utterance_boundary", "silence", "source_center", "authored_range"]
            },
            "min_confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "pre_roll_frames": { "type": "integer", "minimum": 0 },
            "post_roll_frames": { "type": "integer", "minimum": 0 },
            "preferred_duration_frames": { "type": "integer", "minimum": 1 },
            "fallback": {
              "type": "string",
              "enum": ["cut_on_action", "peak_hold", "pre_roll_enter", "post_action_hold", "clean_in_clean_out"]
            }
          },
          "required": ["technique"],
          "additionalProperties": false
        },
        "transition_to_next": {
          "type": "object",
          "properties": {
            "technique": {
              "type": "string",
              "enum": ["hard_cut", "dissolve", "dip_to_black", "j_cut", "l_cut", "match_cut"]
            },
            "preferred_skill": { "type": "string" },
            "snap_to_bgm": { "type": "string", "enum": ["none", "beat", "downbeat"] },
            "fallback": {
              "type": "string",
              "enum": ["hard_cut", "dissolve", "dip_to_black", "j_cut", "l_cut", "match_cut"]
            }
          },
          "required": ["technique"],
          "additionalProperties": false
        },
        "rhythm": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "enum": ["accelerando", "ritardando", "steady", "syncopated", "breath"]
            },
            "max_shot_length_frames": { "type": "integer", "minimum": 1 },
            "min_shot_length_frames": { "type": "integer", "minimum": 1 },
            "snap_to_bgm": { "type": "string", "enum": ["none", "beat", "downbeat"] },
            "preserve_breath": { "type": "boolean" }
          },
          "required": ["pattern"],
          "additionalProperties": false
        },
        "shot_scale": {
          "type": "object",
          "properties": {
            "rule": { "type": "string", "enum": ["wide_to_close", "close_to_wide", "scale_match"] },
            "min_confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "allow_unknown": { "type": "boolean" }
          },
          "required": ["rule"],
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  }
}
```

Important constraints:

- All enum values must be closed and schema-known.
- `preferred_skill` must refer to a registered skill card or active editing skill.
- Frame values are bounds, not freeform wishes.
- `fallback` must itself be a valid lower-complexity technique.
- Missing evidence must produce deterministic degradation, not invented facts.
- The object is optional. Existing blueprints compile as they do today.

## 5. Compiler Execution Model

The compiler should treat craft as a small rule plan layered onto existing phases.

### 5.1 Normalize

Normalize `beats[].craft` into a `NormalizedCraftDirective` per beat:

- Validate enum values.
- Validate frame bounds.
- Resolve default fallbacks.
- Copy only schema-known directives.
- Mark unsupported directives such as P0 `j_cut`, `l_cut`, or `syncopated` as deferred unless the required IR exists.

This phase does not inspect media and does not call models.

### 5.2 Score

Craft can bias candidate scoring, but it should not directly select clips except through explicit `candidate_plan`.

Examples:

- `peak_hold` increases peak salience weight for candidates with high `peak_strength_score`.
- `clean_in_clean_out` penalizes candidates with transcript or event boundaries that cannot support clean cuts.
- `wide_to_close` favors wide/support candidates in earlier beats and close/detail candidates later in the pattern.
- `breath` favors candidates with usable silence, afterglow, or phrase boundaries.
- `accelerando` can progressively raise energy and peak priority.

Scoring output should record craft contribution in the score breakdown so review can explain why a candidate won.

### 5.3 Assemble

Assembly should respect craft only where it can remain deterministic:

- Use `target_duration_frames`, role requirements, and ranked candidates as today.
- Keep `timeline_order` and `track_layout` behavior explicit.
- For shot scale rules, prefer ordering constraints that can be evaluated from candidate evidence.
- For rhythm patterns, adjust only within bounded beat durations or precomputed per-beat targets.

Assembly should not invent extra subclips for a within-beat montage until the IR supports it.

### 5.4 Trim

Trim is the strongest first implementation target.

`applyAdaptiveTrim()` already resolves peak center, preferred duration, min/max duration, authored windows, peak-type asymmetry, and metadata. Craft should add explicit technique selection:

- `cut_on_action` chooses action-centered asymmetry.
- `peak_hold` protects peak duration and post-peak readability.
- `pre_roll_enter` moves the in point earlier within bounds.
- `post_action_hold` moves the out point later within bounds.
- `clean_in_clean_out` combines trim hints with utterance/event boundary snapping.

The result should emit metadata such as:

```json
{
  "editorial": {
    "craft": {
      "in_out": {
        "requested": "post_action_hold",
        "applied": "post_action_hold",
        "anchor": "emotional_peak",
        "degraded_from": null
      }
    }
  }
}
```

### 5.5 Rhythm And BGM

BGM analysis is usable only when `analysis_status: ready`. The compiler can then use:

- `beats_sec` for beat snapping.
- `downbeats_sec` for stronger landing points.
- `sections` for energy-aware placement, such as peak material in higher-energy sections.
- `meter` and BPM for later phrase-level expansion.

Execution rules:

- `snap_to_bgm: beat` can use the existing beat snap target.
- `snap_to_bgm: downbeat` can prefer downbeats as current transition cards do.
- `accelerando` and `ritardando` should first operate at beat-duration level.
- `syncopated` should remain deferred until the BGM analysis exposes offbeat or phase targets.
- BGM snapping must never collapse a clip below the minimum frame guard.

### 5.6 Transition

Transition craft should feed the existing transition skill card system.

Resolution order:

1. Build pair evidence from adjacent clips, candidates, beat story roles, segment adjacency features, peak signals, and BGM snap distance.
2. Filter cards by `active_editing_skills` and craft preference.
3. Evaluate `when`, `avoid_when`, and `minimum_viable`.
4. Compute Murch-weighted score.
5. Apply requested technique if the best card supports it and passes threshold.
6. Otherwise walk the fallback chain and record degradation.

This keeps `match_cut`, `dissolve`, `dip_to_black`, and hard cuts explainable through the same evidence and fallback machinery.

### 5.7 Visual Quality And Safety

Visual quality data should act as a gate, not an aesthetic model inside the compiler.

Examples:

- Do not execute `scale_match` when shot scale confidence is below threshold unless `allow_unknown` is true.
- Penalize candidates with serious `quality_flags` for `peak_hold`; a held shot magnifies defects.
- Prefer `clean_in_clean_out` when motion blur or action ambiguity makes a precise action cut risky.
- Do not use a visually poor candidate merely because it matches the requested shot scale.

The compiler should make these deterministic decisions from materialized fields such as `visual_quality`, `quality_flags`, `adjacency_features`, and `editorial_signals`.

## 6. Agent Decision Vs Structure Enforcement

| Area | Agent decides | Structure enforces |
| --- | --- | --- |
| Intent | The beat should feel sharp, calm, revealing, intimate, or released. | Only closed craft enums enter the blueprint. |
| Technique | Choose `cut_on_action`, `breath`, `match_cut`, `wide_to_close`, etc. | Validate the technique is supported for the phase and evidence available. |
| Evidence interpretation | Which candidate evidence best supports the intended craft. | Candidate refs, segment refs, peak refs, and skill ids must exist. |
| Tradeoff | A weaker visual may be acceptable for a stronger emotional beat. | Quality floors and confidence gates cannot be bypassed silently. |
| Fallback | The agent may nominate a lower-complexity fallback. | Fallback must be valid, deterministic, and no more complex than the requested technique. |
| Timeline execution | None. The agent must not edit `timeline.json`. | Compiler mutates clip timing, transitions, metadata, and diagnostics. |
| Unsupported ideas | Agent can record an uncertainty or reselect request. | Unsupported directives do not become hidden prose instructions. |

The boundary should be strict: the agent chooses values; the schema validates them; the compiler executes them; review measures the result.

## 7. Deterministic Degradation

Every craft directive needs an explicit degradation policy.

Examples:

- `cut_on_action` without an action event degrades to `peak_hold` if a peak exists, otherwise `fixed_authored`.
- `match_cut` with low visual overlap degrades to `dissolve`, then `hard_cut`.
- `dip_to_black` in strict duration mode can degrade to a short dissolve or clean cut.
- `j_cut` and `l_cut` should be rejected or written to the uncertainty register until the audio overlap IR is implemented.
- `syncopated` should be warning-only until offbeat targets exist.
- `wide_to_close` should not reorder unknown shot scales unless `allow_unknown` permits a soft preference.

Degradation should be visible in artifacts:

- `timeline.transitions[].degraded_from_skill_id`
- `timeline.transitions[].transition_params`
- `clip.metadata.editorial.craft`
- `05_timeline/adjacency_analysis.json`
- A future craft execution report, if useful

## 8. Validation And Acceptance

Minimum validation before compile:

- `beats[].craft` validates against the blueprint schema.
- Every enum value is supported or explicitly marked deferred.
- Every `preferred_skill` exists in the registry.
- Every fallback is valid and lower-complexity.
- Numeric frame bounds are positive and internally consistent.
- Required evidence types are present or the directive is downgraded before timeline mutation.

Minimum tests:

- Schema accepts a blueprint with one `craft` object and rejects unknown craft keys.
- Existing blueprints without `craft` produce byte-equivalent timelines.
- `peak_hold` changes trim only when peak evidence exists.
- `clean_in_clean_out` snaps dialogue boundaries when transcripts exist and no-ops when they do not.
- `match_cut` selects `match_cut_bridge` only when pair evidence passes viability.
- `dissolve` lowers to cut when `avoid_when` rejects crossfade.
- BGM snap never collapses adjacent clips below one frame.
- Deferred `j_cut`, `l_cut`, and `syncopated` create warnings or uncertainties rather than silent timeline changes.

Human acceptance:

- A reviewer can read the blueprint and predict the intended craft.
- A reviewer can inspect `timeline.json` and see whether the craft was applied or degraded.
- The same inputs produce the same timeline.
- Removing `craft` returns the compiler to the current behavior.

## 9. Non-Functional Constraints

### Reliability

- Craft execution must be deterministic for identical inputs.
- Unsupported directives must fail closed into warnings, uncertainty entries, or documented degradation before timeline mutation.
- Craft metadata must be merged field-by-field so existing `metadata.trim`, `metadata.editorial.peak`, skill tags, and transition provenance are not overwritten.
- Existing blueprints without `craft` must retain current compile behavior.

### Security

- The compiler must not call an LLM, shell out to arbitrary commands, or inspect raw media to satisfy craft directives.
- Craft directives must only reference known artifact ids, candidate refs, segment refs, peak refs, and registered skill ids.
- Freeform prose must not be treated as an executable craft instruction.

### Performance

- Craft execution should use already-loaded blueprint, selects, segment evidence, BGM analysis, and transcript boundary indexes.
- No phase should introduce frame-by-frame visual inspection inside compile.
- BGM and transcript lookups should stay optional and fail-open to deterministic degradation when artifacts are absent.

### Observability

- Timeline metadata should record requested, applied, and degraded craft where it changes timing or transitions.
- Adjacency analysis should expose pair-level evidence for transition craft.
- A future craft execution report can summarize unmet directives, missing evidence, and fallback counts without becoming a compile dependency.

## 10. Implementation Roadmap

### Phase 1: Schema And Normalization

Goal: introduce the contract without changing compile behavior.

Work:

- Add `beats[].craft` to `schemas/edit-blueprint.schema.json`.
- Add TypeScript types for `CraftDirective`.
- Normalize craft directives into compiler internal data.
- Validate enum values, frame bounds, skill ids, and fallbacks.
- Emit warning-only diagnostics for unsupported directives.

Acceptance:

- Current blueprints remain valid.
- A valid craft object round-trips through blueprint loading.
- Unknown craft fields fail schema validation.
- No timeline output changes unless a craft execution feature is enabled.

### Phase 2: In/Out Execution

Goal: execute the safest craft layer first.

Work:

- Extend adaptive trim to consume normalized in/out craft directives.
- Map `cut_on_action`, `peak_hold`, `pre_roll_enter`, `post_action_hold`, and `clean_in_clean_out` to deterministic trim behavior.
- Merge craft trim metadata without replacing existing `metadata.editorial.peak` or skill metadata.
- Add evidence-gated fallbacks.

Acceptance:

- Peak and event anchored trims are deterministic.
- Missing evidence falls back predictably.
- Dialogue boundary snapping still passes speech-cut checks.
- Strict duration caps are enforced after trim changes.

### Phase 3: Transition Execution

Goal: connect transition craft to the skill-card system.

Work:

- Let `transition_to_next.technique` bias or constrain transition card selection.
- Add aliases from craft terms to current primitives: `hard_cut -> cut`, `dissolve -> crossfade`, `dip_to_black -> fade_to_black`.
- Keep `match_cut` on the existing `match_cut_bridge` viability path.
- Reject or defer `j_cut` and `l_cut` until audio overlap execution exists.
- Record requested/applied/degraded transition craft in transition params or metadata.

Acceptance:

- Requested transition craft never bypasses `when`, `avoid_when`, or `minimum_viable`.
- Fallback chains are visible.
- BGM snapping still respects tolerance and minimum frame guards.

### Phase 4: Rhythm Execution

Goal: add bounded beat-level rhythm before within-beat IR.

Work:

- Resolve `accelerando`, `ritardando`, `steady`, and `breath` into per-beat duration and scoring modifiers.
- Use ready BGM analysis for beat/downbeat snapping.
- Keep `syncopated` warning-only until offbeat or phase evidence exists.
- Add diagnostics comparing requested rhythm to actual cut intervals.

Acceptance:

- Rhythm modifiers respect `duration_policy`.
- Existing guide and strict modes remain predictable.
- No within-beat subclip splitting is introduced accidentally.

### Phase 5: Shot Scale Execution

Goal: make visual continuity rules deterministic.

Work:

- Materialize shot scale confidence from segment adjacency features into candidate evidence where needed.
- Add scoring or ordering modifiers for `wide_to_close`, `close_to_wide`, and `scale_match`.
- Connect `scale_match` to `match_cut` viability and composition match.
- Emit diagnostics when shot scale evidence is absent or below confidence.

Acceptance:

- Unknown shot scale does not cause forced reordering by default.
- Scale rules improve adjacency decisions without overriding quality floors.
- Review can identify when a requested scale rule was unmet.

### Phase 6: Agent Integration

Goal: let the craft agent write structure, not prose.

Work:

- Update the editorial craft agent prompt to emit `beats[].craft` edits only through schema-known fields.
- Reject freeform craft instructions outside the schema.
- Convert unsupported craft ideas into uncertainty entries or reselect requests.
- Feed post-compile craft execution diagnostics back into later craft reviews.

Acceptance:

- The agent cannot mutate `timeline.json`.
- Every accepted craft directive validates before compile.
- Repeated unsupported directives are escalated instead of silently ignored.

## 11. Risks

### Overconstraint

Too many craft directives can make the compiler brittle or prevent good fallback choices. Mitigation: keep `craft` optional, require confidence gates, and make fallback mandatory for higher-complexity techniques.

### Hidden Schema Drift

Putting craft prose into `notes` would recreate the current ambiguity. Mitigation: reject unsupported craft outside the closed object and keep schema validation strict.

### Evidence Mismatch

The agent may request `cut_on_action` where Marlin did not detect action evidence. Mitigation: validate evidence anchors and degrade before timeline mutation.

### IR Limitations

`j_cut`, `l_cut`, `syncopated`, and within-beat accelerando may require audio overlap or multi-clip IR. Mitigation: mark them deferred until the compiler has the necessary representation.

### Quality Regression

Craft rules may over-prioritize a technically poor but semantically matching shot. Mitigation: keep quality flags and visual quality floors in scoring and execution gates.

## 12. Rollback

Rollback should be simple:

- Omit `beats[].craft` from new blueprints.
- Treat existing craft objects as warning-only.
- Disable craft execution feature flags phase by phase.
- Keep current `active_editing_skills`, `trim_policy`, transition skill cards, and compile flow unchanged.

Because the design is additive and optional, existing projects should not require migration.

## 13. Summary

The structure-first path makes editorial craft executable by turning editing vocabulary into schema. The agent can still make creative choices, but it must express those choices as bounded directives: in/out technique, transition technique, rhythm pattern, and shot scale rule.

The compiler then applies those directives using the evidence it already knows how to consume: Marlin temporal events and peaks materialized into trim hints and editorial signals, BGM beat/downbeat analysis, transition pair evidence, visual quality, and adjacency features.

This keeps the core split intact: agents decide intent, structure constrains expression, the compiler executes deterministically, and review verifies the result.
