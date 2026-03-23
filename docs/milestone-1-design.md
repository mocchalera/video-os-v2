# Milestone 1 Design

## Scope

Milestone 1 adds the artifact contracts that exist before and after `timeline.json` in the editorial loop.
The goal is to make `creative_brief.yaml`, `selects_candidates.yaml`, `edit_blueprint.yaml`,
`uncertainty_register.yaml`, and `review_report.yaml` machine-validated inputs and outputs with the
same strictness style as the existing `timeline-ir.schema.json` and `review-patch.schema.json`.

## Schema decisions

### `creative-brief.schema.json`

- Rooted in `projects/_template/01_intent/creative_brief.yaml`, so the required sections remain:
  `project`, `message`, `audience`, `emotion_curve`, `must_have`, `must_avoid`, `autonomy`,
  and `resolved_assumptions`.
- The role prompt for `intent-interviewer` says a `strategy` section is required. The existing template
  already stores strategy at `project.strategy`, so the schema keeps that location canonical instead of
  introducing a second top-level `strategy` field.
- `hypotheses` and `forbidden_interpretations` are optional because the role prompt explicitly tells the
  agent to preserve both, but the starter template does not yet require them on every project.
- `version`, `project_id`, and `created_at` are optional metadata to preserve compatibility with the
  current template while still allowing stronger fixture data.

### `unresolved-blockers.schema.json`

- `unresolved_blockers.yaml` is a canonical artifact and compile gate input, so Milestone 1 now gives it
  its own schema and starter template.
- The root contract is `version`, `project_id`, optional `created_at`, and `blockers[]`.
- Each blocker entry follows the `intent-interviewer` prompt shape exactly:
  `id`, `question`, `status`, `why_it_matters`, and `allowed_temporary_assumption`.
- `status` is limited to `blocker`, `hypothesis`, `resolved`, and `waived`.
- An empty `blockers: []` array is valid so the sample fixture can remain compilable when no live blocker exists.

### `selects-candidates.schema.json`

- Derived from the `footage-triager` contract. The required per-candidate fields are exactly the fields
  named in the role prompt: `segment_id`, `asset_id`, `src_in_us`, `src_out_us`, `role`,
  `why_it_matches`, `risks`, and `confidence`.
- `role` allows `reject` because the role spec explicitly permits that classification even though the
  compiler should ignore rejected items for assembly.
- Optional `semantic_rank`, `quality_flags`, and `evidence` were added because `ARCHITECTURE.md`
  Phase 2 says candidate scoring should consider semantic rank and quality signals, and the triager prompt
  explicitly prefers evidence-backed selection.
- `eligible_beats`, `transcript_excerpt`, and `motif_tags` are optional convenience fields for deterministic
  scoring and fixture readability; they do not replace beat-level matching from the blueprint.
- JSON Schema keeps `src_in_us` and `src_out_us` as non-negative integers only. The stricter invariant
  `src_in_us < src_out_us` is enforced by the validator runner, not by draft 2020-12 alone.

### `edit-blueprint.schema.json`

- Rooted in `projects/_template/04_plan/edit_blueprint.yaml`, which already defined `sequence_goals`,
  `beats`, `pacing`, `music_policy`, `dialogue_policy`, `transition_policy`, and `ending_policy`.
- `rejection_rules` was made required because the `blueprint-planner` role says the artifact must define it.
  The template was updated accordingly so the template and schema stay aligned.
- Beat entries require `id`, `label`, `target_duration_frames`, and `required_roles`. `purpose`,
  `preferred_roles`, and `notes` stay optional so the schema supports both the minimal template and a richer
  planning artifact.
- Beat roles are limited to the compiler's selectable editorial roles:
  `hero`, `support`, `transition`, `texture`, and `dialogue`. Music and title treatment are handled through
  `music_policy` and downstream overlay tracks instead of `beats[].required_roles`.
- `music_policy.entry_beat` records the earliest beat where BGM may enter. Milestone 1 still allows the
  compiler to emit an empty `A2` track if no music cue is chosen.
- `caption_policy` is optional in Milestone 1 and carries `language`, `delivery_mode`, `source`,
  and `styling_class` when a project wants to plan captions before Milestone 4.

### `uncertainty-register.schema.json`

- Directly mirrors the `blueprint-planner` required output fields: `id`, `type`, `question`, `status`,
  `evidence`, `alternatives`, and `escalation_required`.
- `status` includes `blocker` because the architecture state machine has an explicit blocked state tied to
  unresolved blocking uncertainty.
- `alternatives` are structured objects instead of raw strings so later tooling can present them cleanly and
  compare trade-offs without reparsing prose.
- `resolution_note` is optional for resolved items so the register can also serve as an audit trail.

### `review-report.schema.json`

- Rooted in the `roughcut-critic` required sections:
  `summary_judgment`, `strengths`, `weaknesses`, `fatal_issues`, `warnings`,
  `mismatches_to_brief`, `mismatches_to_blueprint`, and `recommended_next_pass`.
- `summary_judgment` is an object with `status`, `rationale`, and optional `confidence` so approval state is
  machine-readable rather than embedded in prose.
- `strengths` and `weaknesses` use a shared observation shape with optional evidence and affected beat/clip ids.
- `fatal_issues` and `warnings` now use severity-specific finding definitions so a `fatal_issues[]` item must
  carry `severity: fatal` and a `warnings[]` item must carry `severity: warning`.
- Mismatch arrays require `expected_ref`, `observed_issue`, and `why_it_matters` because the critic prompt
  says factual mismatches must lead over taste-level commentary.

## Fixture design intent

The `projects/sample/` fixture is intentionally small but not trivial:

- One coherent editorial premise: a restorative mountain morning film that must not drift into athletic triumph.
- Six assets create useful variety: interior interview, ritual b-roll, hands detail, trail movement,
  release close-ups, and forest textures.
- Thirty-six segments are enough to exercise segment lookup, role coverage, and repeated-motif constraints.
- Three transcript files provide spoken material at the beginning, middle, and end of the arc.
- The selects set includes minor quality risks and overlapping role options so later compiler and critic work
  can exercise trade-offs instead of only obvious one-to-one choices.
- `unresolved_blockers.yaml` is intentionally empty so the sample is compilable once the compiler exists.
- `uncertainty_register.yaml` still contains live-but-tolerable ambiguity so the planning layer exercises
  explicit uncertainty handling without tripping the hard blocker gate.

## Timeline compiler inputs

For deterministic compilation, the compiler needs:

1. `creative_brief.yaml`
   - message hierarchy
   - audience framing
   - emotion curve
   - must-have and must-avoid constraints

2. `selects_candidates.yaml`
   - candidate ids and source ranges
   - editorial role per candidate
   - confidence and semantic ranking
   - quality and evidence signals
   - source-range ordering is checked in a validator runner as a second stage after JSON Schema

3. `edit_blueprint.yaml`
   - sequence goals
   - beat sheet with target durations
   - required roles per beat
   - pacing and policy constraints
   - rejection rules
   - optional caption policy

4. Gate inputs around compilation
   - `unresolved_blockers.yaml` must not contain active blockers
   - `uncertainty_register.yaml` may contain tolerated ambiguity, but `status: blocker` should stop compile or render
   - validation is two-stage: JSON Schema first, then validator-runner invariants such as `src_in_us < src_out_us`

5. Compiler-owned defaults
   - motif reuse limits, adjacency penalties, beat-alignment tolerance, and related deterministic scoring values
     live in `runtime/compiler-defaults.yaml`
   - those values are fixed compiler policy in Milestone 1 and are not overridable from brief or blueprint

The compiler does not need `assets.json` and `segments.json` as its primary creative input if selects are already
valid, but those analysis artifacts remain necessary for fixture integrity checks and for regenerating selects.

## Text relationship diagram

```text
meeting notes / reference board / project brief
  -> 01_intent/creative_brief.yaml
  -> 01_intent/unresolved_blockers.yaml

03_analysis/assets.json
  -> 03_analysis/segments.json
  -> 03_analysis/transcripts/*.json
  -> 04_plan/selects_candidates.yaml

01_intent/creative_brief.yaml
01_intent/unresolved_blockers.yaml
04_plan/selects_candidates.yaml
  -> 04_plan/edit_blueprint.yaml
  -> 04_plan/uncertainty_register.yaml

01_intent/creative_brief.yaml
04_plan/selects_candidates.yaml
04_plan/edit_blueprint.yaml
  -> timeline compiler
  -> 05_timeline/timeline.json

05_timeline/timeline.json
05_timeline/review.mp4
01_intent/creative_brief.yaml
04_plan/edit_blueprint.yaml
  -> 06_review/review_report.yaml
  -> 06_review/review_patch.json
```

## Strictness policy

- `timeline-ir.schema.json` intentionally leaves `clip.metadata` and `marker.metadata` open as extension points.
- All other Milestone 1 artifact schemas use `additionalProperties: false` to keep the contracts closed.
