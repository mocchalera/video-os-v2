# QA Final Package Gates

Date: 2026-07-09

## Scope

- Added `06_review/editorial_pipeline_status.json` as a schema-validated editorial pipeline status artifact.
- Recorded QA outcomes as distinct preview/final/package states:
  - QA failure keeps rendered preview available when present.
  - QA failure blocks final render and package output with a fatal `QA_LOOP_FAILED` issue.
  - skipped QA blocks final render and package output with `QA_SKIPPED`.
  - successful QA remains separate from final approval by leaving final/package status as `not_requested`.
- Added `schemas/editorial-pipeline-status.schema.json` to make the status artifact strict and machine-readable.
- Extended Gate 10 package validation so unresolved `review_report.fatal_issues` block packaging unless the approval record is `creative_override`.
- Added unit and E2E coverage for the new status artifact and fatal-review package gate behavior.

## Verification

```text
npm test -- tests/editorial-pipeline-status.test.ts tests/m4-qa.test.ts tests/e2e-m4.test.ts
-> 3 test files passed, 58 tests passed

npx tsc --noEmit
-> passed

npm run validate
-> projects/demo valid: artifacts_checked 15, error_count 0, warning_count 0

npm run build
-> passed

npm run verify
-> typecheck passed
-> unit-tests passed: 152 files passed, 2577 tests passed, 39 skipped
-> schema-validation (demo) passed: artifacts_checked 15, error_count 0, warning_count 0
-> review-metrics (demo) passed
-> All gates passed

npm run verify:repo
-> Repo hygiene passed for 1360 tracked file(s)

git diff --check
-> passed
```

## Notes

- `npm run verify` regenerated `projects/demo/06_review/review_metrics.json`; that generated diff was inspected and removed from the worktree because it is not part of this task.
