# macOS Studio CI Evidence

Date: 2026-07-09

## Scope

Implemented the next CI governance slice from the third-party review:
macOS Studio is now covered by a dedicated GitHub Actions job.

This slice covers:

- `.github/workflows/ci.yml`
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectStudioSyntheticSmoke.swift`

## Changes

- Added a `macos-studio` CI job on `macos-14`.
- The job runs `swift test`.
- The job runs `swift run videoos-studio-cli doctor` as a lightweight CLI smoke.
- Fixed existing synthetic Studio smoke fixture drift found while preparing the CI job:
  - the fixture now writes transcript evidence for dialogue planning readiness;
  - `selects_candidates.yaml` is written before `edit_blueprint.yaml`, keeping the blueprint freshness gate valid.

## Verification

Commands run locally:

```text
swift test --filter 'ProjectStudioSyntheticSmokeTests|ProjectStudioAcceptanceSmokeTests'
=> 2 tests passed

swift test
=> 516 tests passed, 0 failures

swift run videoos-studio-cli doctor
=> Video OS Studio doctor completed; repo detected; projects=28

ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml"); puts "workflow yaml ok"'
=> workflow yaml ok

git diff --check
=> passed
```

## Notes

- Initial `swift test` failed with 516 tests executed and 2 failures. Both failures were existing smoke fixture drift: Studio readiness expected `9/9` but the synthetic project produced `8/9`.
- The fix keeps the test expectation intact and updates the fixture to satisfy the current planning gate semantics.
- The existing Ubuntu Node job is intentionally left named `test` to avoid unnecessary branch-protection churn.
