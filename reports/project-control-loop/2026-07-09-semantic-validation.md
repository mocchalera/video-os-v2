# Semantic Artifact Validation

Date: 2026-07-09

## Scope

- Added timeline semantic validation beyond JSON Schema:
  - duplicate `track_id` detection
  - duplicate `clip_id` detection
  - transition ID uniqueness
  - transition `from_clip_id` / `to_clip_id` references must point to existing clips
  - clip caption `in_frame` / `out_frame` bounds
  - marker frame bounds against inferred timeline duration
  - timeline clip `asset_id` coverage when `source_map.json` exists
- Added optional validation for `06_review/editorial_pipeline_status.json`; blocked final/package states now fail semantic validation.
- Added optional validation for `07_package/qa-report.json`; `passed: false` now fails semantic validation.
- Kept existing demo validation clean: `projects/demo` still validates with 15 artifacts checked, 0 errors, 0 warnings.
- Added schema-contract regression tests for the new semantic checks.

## Verification

```text
npx vitest run tests/validate.test.ts
-> 1 test file passed, 36 tests passed

npx tsc --noEmit
-> passed

npm run validate
-> projects/demo valid: artifacts_checked 15, error_count 0, warning_count 0

npm run test:schema-contract
-> 3 test files passed, 85 tests passed

npm run verify:repo
-> Repo hygiene passed for 1365 tracked file(s)

git diff --check
-> passed
```
