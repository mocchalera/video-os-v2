# P4c Confidence Calibration Implementation Notes

## 1. Baseline Snapshot

- Start command: `git status --short`
- Start state: existing dirty worktree included unrelated `.github/`, `editor/`, `runtime/render/`, packaging, `package.json`, `schemas/timeline-ir.schema.json`, and tmp media changes. P4c work did not revert or edit those unrelated changes.
- Demo timeline canonical hash baseline, with `created_at` excluded: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Baseline tests: `npx vitest run` -> 68 files passed, 1 skipped; 1844 passed, 12 skipped.
- Baseline typecheck: `npm run build` -> pass.

## 2. Allowlist Compliance

P4c-created files:

- `schemas/confidence-calibration-report.schema.json`
- `scripts/eval-confidence-calibration.ts`
- `runtime/artifacts/p4c-confidence-calibration.ts`
- `tests/confidence-calibration-report.test.ts`
- `tests/confidence-calibration-fields.test.ts`
- `tests/fixtures/confidence_calibration_report/valid_minimal.json`
- `tests/fixtures/confidence_calibration_report/valid_full_metrics.json`
- `tests/fixtures/confidence_calibration_report/valid_with_failures.json`
- `tests/fixtures/confidence_calibration_report/invalid_missing_metrics.json`
- `tests/fixtures/confidence_calibration_report/invalid_bucket_inconsistency.json`
- `tests/fixtures/confidence_calibration_report/edge_no_failures.json`
- `docs/p4c-confidence-calibration-implementation-notes.md`

P4c-modified existing files:

- `schemas/analysis-common.schema.json`
- `runtime/validation/schema-validator.ts`
- `runtime/artifacts/p4a-release-safety.ts`
- `runtime/commands/status.ts`
- `tests/release-safety-report.test.ts`

No existing fixture, compiler output logic, release safety schema, delivery profile schema, project state schema, timeline schema, package files, or GitHub files were changed by P4c.

## 3. confidence-record Extension

`schemas/analysis-common.schema.json` kept `required: ["score", "source", "status"]` unchanged because this repo already had those fields before P4c.

Added optional properties:

- `calibration_model_id`: `CALMOD_` string or null
- `calibrated_score`: number 0-1 or null
- `confidence_bucket`: `very_low | low | medium | high | very_high` or null
- `expected_error_rate`: number 0-1 or null
- `eval_set_id`: `EVALSET_` string or null

`status` now explicitly accepts the P4c calibration statuses plus existing fixture statuses: `raw`, `calibrated`, `human_verified`, `low_signal`, `unsupported`, `ready`, `partial`, `confirmed`, `provisional`.

## 4. confidence_calibration_report Schema

Schema path: `schemas/confidence-calibration-report.schema.json`

Required root fields:

- `version`
- `project_id`
- `artifact_version`
- `created_at`
- `report_id`
- `eval_set_id`
- `calibration_model_id`
- `artifact_versions`
- `metrics`
- `buckets`
- `failures`
- `recommendations`
- `provenance`

Optional/extensible fields:

- `artifact_versions` requires `audio_story_graph_version`, `continuity_graph_version`, and `assets_version`, and permits additional artifact version refs.
- `failures` and `recommendations` may be empty arrays.
- No wrapper object was added.

Hash policy is `normalized-json-v1` with `created_at` excluded.

## 5. P4a Integration

The release safety category enum is unchanged. P4c adds checks inside the existing `delivery_profile` category only when both flags are enabled:

- `ENABLE_P4B_DELIVERY_PROFILES=true`
- `ENABLE_P4C_CONFIDENCE_CALIBRATION=true`

Rules:

- `requires_calibrated_confidence !== true`: no extra check is appended, preserving P4b behavior.
- Report absent with `public` or `external`: `blocker`.
- Report absent with `internal`: `warning`.
- Malformed report: `blocker` for public/external, `warning` for internal.
- Stale artifact version hash: `warning`.
- Present and fresh: `pass`.

## 6. Eval CLI

Script: `scripts/eval-confidence-calibration.ts`

Arguments:

- `--project <path>`
- `--eval-set <EVALSET_id>`
- `--calibration-model <CALMOD_id>`
- `--output <path>`

The command is independent from compile/render/package. It exits with an error unless `ENABLE_P4C_CONFIDENCE_CALIBRATION` is truthy. The implementation writes a schema-valid placeholder report from current artifact hashes; real calibration model logic remains out of scope.

## 7. Test Red To Green

Red check:

- Added P4c tests and ran targeted suite before implementation.
- Expected failures were missing `p4c-confidence-calibration` module, missing schema, and missing release safety integration.

Green checks:

- `npx vitest run tests/confidence-calibration-report.test.ts tests/confidence-calibration-fields.test.ts tests/release-safety-report.test.ts` -> 35 passed.
- After adding backcompat for existing `status: provisional`, `npx vitest run tests/analysis-schemas.test.ts tests/confidence-calibration-fields.test.ts tests/confidence-calibration-report.test.ts` -> 58 passed.

## 8. Feature Flag Design

Flag: `ENABLE_P4C_CONFIDENCE_CALIBRATION`

OFF:

- P4a delivery profile checks remain P4b-only.
- Calibration report is not loaded by release safety.
- `/status` does not expose calibration report status.
- Existing runtime output paths are unchanged.

ON:

- Release safety loads `projects/<id>/08_eval/confidence_calibration_report.json`.
- `/status` reports calibration report presence, validity, `eval_set_id`, and `calibration_model_id`.
- Eval CLI can generate the report.

## 9. Open Questions

Q8 confidence calibration decision:

- P4c implements the schema receiver, report schema, report loader, recency/hash checks, release safety opt-in check, and eval CLI shell.
- The real calibration model and learning/evaluation algorithm are deferred to P5 or later.
- `delivery_profile.requires_calibrated_confidence` is the opt-in release safety trigger.

Q4 rights authority and Q5 human approval UI remain outside P4c scope.

## 10. Canonical Hash Verification

- Baseline demo timeline canonical hash: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Final demo timeline canonical hash: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`

## 11. Existing Fixture Backward Compatibility

- Existing confidence-record fixture files found under `tests/fixtures`: 20 files.
- Backward compatibility was covered by existing analysis schema tests plus `tests/confidence-calibration-fields.test.ts`.
- Existing fixture files were not modified.

## 12. P4d Handoff

- P4d `segment_search_index` should reuse the same feature-flag and canonical-hash pattern.
- If P4d references confidence calibration, consume the report through `runtime/artifacts/p4c-confidence-calibration.ts`; do not read eval artifacts from compiler paths.
- Keep any P4d release safety check inside existing categories unless a later design explicitly changes the release safety schema.

## 13. Final Git Status

P4c-scoped `git status --short` at completion:

```text
 M runtime/artifacts/p4a-release-safety.ts
 M runtime/commands/status.ts
 M runtime/validation/schema-validator.ts
 M schemas/analysis-common.schema.json
 M tests/release-safety-report.test.ts
?? docs/p4c-confidence-calibration-implementation-notes.md
?? runtime/artifacts/p4c-confidence-calibration.ts
?? schemas/confidence-calibration-report.schema.json
?? scripts/eval-confidence-calibration.ts
?? tests/confidence-calibration-fields.test.ts
?? tests/confidence-calibration-report.test.ts
?? tests/fixtures/confidence_calibration_report/
```

Final verification:

- `npx vitest run` -> 70 files passed, 1 skipped; 1861 passed, 12 skipped.
- `npm run build` -> pass.
- Eval CLI ON smoke -> wrote `/tmp/video-os-p4c-confidence-report.json`.
- Eval CLI OFF smoke -> exited 1 with `ENABLE_P4C_CONFIDENCE_CALIBRATION must be true...`.

## 14. Acceptance Checklist

- [x] allowlist外変更ゼロ for P4c-authored changes
- [x] confidence-record extension is optional-only for new fields; existing required list unchanged
- [x] existing confidence-record fixtures remain schema-compatible
- [x] new calibration report fixtures cover valid 3 / invalid 2 / edge 1
- [x] feature flag OFF demo canonical hash baseline matches final
- [x] feature flag OFF full test suite passes
- [x] feature flag ON adds release_safety calibration check
- [x] `requires_calibrated_confidence == false` keeps P4b behavior identical
- [x] eval CLI is independent from runtime output
- [x] final git status recorded
