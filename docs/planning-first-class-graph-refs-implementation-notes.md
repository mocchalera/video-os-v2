# Planning First-Class Graph Refs Implementation Notes

## 1. Baseline snapshot

- Date: 2026-04-27
- Initial `git status --short`: dirty before this task, with pre-existing OSS readiness, editor, render, packaging, schema, and tmp changes outside this task allowlist. This task did not reset or modify those files.
- Demo timeline canonical hash, excluding top-level `created_at`: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Baseline `npm test`: 65 files passed, 1 skipped; 1796 tests passed, 12 skipped.
- Existing planning artifacts checked by test:
  - 16 `selects_candidates.yaml` files under `projects/*/04_plan/`
  - 17 `edit_blueprint.yaml` files under `projects/*/04_plan/`

## 2. Old wrapper patterns

- `runtime/commands/triage.ts`
  - P2 wrote `audio_story_graph_hash:*` and `audio_story_node_ref:*` strings into `candidate.evidence`.
  - P3 wrote `continuity_graph_hash:*` and `continuity_risk_ref:*` strings into `candidate.evidence`.
  - P3 also appended continuity risk text into `candidate.risks`.
- `runtime/commands/blueprint.ts`
  - P2 wrote graph-derived role into existing `beat.story_role`.
  - P2 wrote `audio_story_graph:* refs:*` strings into `beat.notes`.
  - P3 wrote `continuity_graph:* risks:*` strings into `beat.notes`.
  - P3 wrote `editorial_preference_memory refs:*` strings into `beat.notes`.
- `runtime/commands/review.ts`
  - Review warnings remain report-only, but old `*_ref:*` evidence string labels were renamed to `*_id:*` so planning wrapper grep is clean.

## 3. New first-class field spec

### `selects_candidates.yaml`

Optional per-candidate fields:

- `audio_story_refs[]`
  - `node_id`: `ASG_`, `UTTREF_`, `SPKREF_`, `AEREF_`, or `BGMREF_`
  - `role`: `hook`, `setup`, `experience`, `payoff`, `reaction`, `closing`
  - `confidence`: local `confidenceRecord` shape aligned with analysis-common `confidence-record`
  - `graph_hash`: consumed `audio_story_graph` hash
- `continuity_refs[]`
  - `entity_id`: `ENT_SUBJECT_`, `ENT_LOCATION_`, `ENT_PROP_`, `ENT_MOTIF_`, or `ENT_ACTION_`
  - `risk_id`: `CONRISK_`
  - `severity`: `info`, `warning`, `blocker`
  - `graph_hash`: consumed `continuity_graph` hash

### `edit_blueprint.yaml`

Optional per-beat fields:

- `audio_story_role`
  - `node_id`
  - `role`
  - `evidence_node_ids[]`
  - `graph_hash`
- `continuity_constraint`
  - `chronology`: `chronological`, `editorial_reorder`, `deliberate_discontinuity`
  - `enforced_entity_ids[]`
  - `graph_hash`
- `applied_preferences[]`
  - `entry_id`
  - `preference_type`
  - `consumed_offset`
  - `consumed_hash`

## 4. Schema revision

- `schemas/selects-candidates.schema.json`
  - Added optional `audio_story_refs` and `continuity_refs` to `$defs.candidate`.
  - Added `$defs.audioStoryRef` and `$defs.continuityRef`.
  - Did not change top-level or candidate `required`.
- `schemas/edit-blueprint.schema.json`
  - Added optional `audio_story_role`, `continuity_constraint`, and `applied_preferences` to `$defs.beat`.
  - Added `$defs.audioStoryRole`, `$defs.continuityConstraint`, and `$defs.appliedPreference`.
  - Did not change top-level or beat `required`.

## 5. Version bump judgment

- Additive optional planning fields are a minor schema-contract change under P0 Section 5.
- New first-class fixtures use `version: "1.1.0"`.
- Runtime projection bumps semver-like `1.0.0` planning outputs to `1.1.0` only when first-class fields are actually materialized.
- Non-semver or already `>=1.1.0` versions are left unchanged.
- `base_timeline_version` is not updated: compiler output schema and timeline-bound release safety inputs are not changed.

## 6. Migration impact

- Existing planning artifacts with no first-class fields remain valid.
- Feature flags remain OFF by default:
  - `ENABLE_P2_AUDIO_STORY_GRAPH`
  - `ENABLE_P3_CONTINUITY_PREFERENCE`
- ON-mode now writes first-class fields instead of wrapper strings in planning artifacts.
- Compiler output logic was not changed.
- Compiler direct graph/preference reference grep returned zero hits for `runtime/compiler`.

## 7. Test Red to Green

- Red:
  - `npx vitest run tests/planning-first-class-fields.test.ts` failed because schemas rejected first-class fields under `additionalProperties:false`.
  - Focused graph/preference tests failed because first-class projection helpers were not exported and wrapper fields were still used.
- Green:
  - `npx vitest run tests/audio-story-graph.test.ts tests/continuity-graph.test.ts tests/editorial-preference-memory.test.ts tests/planning-first-class-fields.test.ts`
  - Result: 4 files passed, 46 tests passed.
  - `npx tsc --noEmit`
  - Result: passed.

## 8. Canonical hash

- Baseline hash excluding top-level `created_at`: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Post-change hash excluding top-level `created_at`: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Result: identical. Feature flags are OFF and compiler output logic was not changed.

## 9. Wrapper deletion grep

Command:

```bash
rg -n "audio_story_graph_hash|audio_story_node_ref|continuity_graph_hash|continuity_risk_ref|audio_story_graph:|continuity_graph:|editorial_preference_memory refs" runtime/commands runtime/artifacts tests || true
```

Result after implementation: zero hits.

## 10. P4 handoff risks

- `runtime/compiler` still does not consume the new first-class fields. P4 can use them if release-safety enforcement needs planning-level graph evidence, but should avoid direct graph artifact reads from compiler paths.
- `review_report.yaml` has no new first-class schema fields in this task. Review remains report-only and uses warning evidence IDs, not planning materialization.
- Foreign-reference existence and hash freshness are schema-prefix and materialized-hash level only here. Full artifact-level existence checks remain a later validator enhancement.

## 11. Final status

Full verification:

- `npm test`: 66 files passed, 1 skipped; 1807 tests passed, 12 skipped.
- `npx tsc --noEmit`: passed.
- Existing planning artifact compatibility: covered by `tests/planning-first-class-fields.test.ts`.
- New first-class fixtures: covered by `tests/planning-first-class-fields.test.ts`.

Task-derived `git status --short` entries:

```text
 M runtime/commands/blueprint.ts
 M runtime/commands/review.ts
 M runtime/commands/triage.ts
 M schemas/edit-blueprint.schema.json
 M schemas/selects-candidates.schema.json
 M tests/audio-story-graph.test.ts
 M tests/continuity-graph.test.ts
 M tests/editorial-preference-memory.test.ts
?? docs/planning-first-class-graph-refs-implementation-notes.md
?? tests/fixtures/edit_blueprint_first_class/
?? tests/fixtures/selects_candidates_first_class/
?? tests/planning-first-class-fields.test.ts
```

Allowlist check: pass. No editor, compiler output logic, timeline schema, project-state schema, existing fixture, package, lockfile, or GitHub workflow files were changed by this task.
