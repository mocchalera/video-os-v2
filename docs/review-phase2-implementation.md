# Review: Phase 2 Candidate Swap Browser Implementation

Date: 2026-06-22

## Summary

Overall judgment: **Concern**

The implementation is directionally aligned with the Phase 2 design and the reviewed tests/builds pass, but two design edges need attention before calling it complete:

- **Fail:** `ProjectThumbnailCache` does not implement the documented thumbnail resolution order. It resolves representative frames and posters before `key_frame_path`, while the design requires `key_frame_path -> analysis frames -> poster_path -> ffmpeg fallback`.
- **Concern:** Beat-level `fallback_candidate_refs` are loaded and displayed as badges only when the candidate already passes the `eligible_beats` filter. They are not composed into the alternatives list as a separate fallback source.

Verification run:

- `npx vitest run scripts/read-candidates.test.ts` - passed, 3 tests.
- `swift test --filter CandidateBrowserDataSourceTests` - passed, 3 tests.
- `swift build --product VideoOSStudio` - passed.

## Review Checklist

| # | Area | Judgment | Notes |
|---|---|---|---|
| 1 | `read-candidates.ts` JSON output vs `docs/design-studio-feedback-loop.md` Section 4.2 | **Concern** | The output includes the required candidate fields plus `beat_plans`, but it is a wrapper object (`project_id`, `candidates`, `beat_plans`) rather than the literal "JSON array of candidates" wording in the design. This is probably the right shape for Swift because fallback refs need a container, but the implementation/design wording should be reconciled. |
| 2 | YAML loading vs `runtime/compiler/types.ts` | **Pass** | The script imports `Candidate`, `EditBlueprint`, and `SelectsCandidates` through `runtime/artifacts/types.ts`, which re-exports `runtime/compiler/types.ts`. The accessed fields match `Candidate`, `CandidatePlan`, `Beat`, and `EditBlueprint`. Runtime schema validation is intentionally light. |
| 3 | `CandidateBrowserDataSource` subprocess pattern | **Concern** | It uses `SubprocessRunner`, so pipe handling is consistent. It does not follow the fuller runner pattern used by analysis/compile runners: no plan/readiness type, no injectable runner, and no returned stdout/stderr/status for UI diagnostics. |
| 4 | `candidates(forBeat:)` filter/sort | **Concern** | Filtering by `eligible_beats` and sorting by descending confidence are correct for the primary path. Fallback refs are not included if they are not also eligible for the beat, and fallback order from `candidate_plan` is not used for ranking. |
| 5 | `ProjectThumbnailCache` 4-stage chain and golden artifacts | **Fail** | It does not follow the design order. Current order is representative frame -> poster -> key frame -> ffmpeg fallback. The design requires key frame -> representative frame -> poster -> fallback. It does not rewrite golden/planning artifacts; it only reads project artifacts and writes fallback cache files outside the project. |
| 6 | ffmpeg on-demand fallback location | **Pass** | Fallback thumbnails are generated under `FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)`, specifically `VideoOSStudio/Thumbnails/{projectKey}/{assetID}.jpg`. This does not write into the project directory. Caveat: seek time is hard-coded to `0.5` rather than using a representative frame time. |
| 7 | `CandidateSwapView` layout | **Pass** | The sheet follows the wireframe: header, left current clip panel, right alternatives list, and candidate cards with thumbnail, score, role, evidence, trim hint, and action button. |
| 8 | "Use This" operation | **Pass** | The button calls `feedbackSession.addOp(.replaceSegment(...))` with `target_clip_id: clip.id`, `with_segment_id: candidate.segment_id`, `with_candidate_ref: candidate.candidate_id`, and a non-empty reason. This matches the compiler patch schema. |
| 9 | `StudioViewModel` swap browser state | **Concern** | The state is MainActor-bound and project-change guarded, which is good. Failures are collapsed to an empty data source, and `swapBrowserClip` is not cleared on normal sheet dismissal, so the UI cannot distinguish loading failure from a legitimate empty candidate set. |
| 10 | SwiftUI sheet data flow | **Pass** | `ContentView` presents a loading state until both `swapBrowserClip` and `candidateDataSource` are present, then passes the selected clip, candidate source, evidence store, project URL, and feedback session into the sheet. |
| 11 | Test coverage | **Concern** | Existing TS/Swift tests cover JSON shape, CLI output, decoding, filtering/sorting, and fallback ref access. Missing coverage: subprocess non-zero/stderr path, missing YAML, malformed JSON, empty candidates in UI, fallback refs that are not in `eligible_beats`, thumbnail resolution order, ffmpeg cache location, and `Use This` operation wiring. |
| 12 | Error handling | **Concern** | Empty candidates are handled in the view. Subprocess failure, YAML absence, and JSON decode failure all become `CandidateBrowserDataSource.empty(...)`, which hides actionable errors from the user and makes failures look like valid empty planning data. |

## Findings

### [Fail] Thumbnail resolution order does not match the design

Evidence:

- Design order: `key_frame_path` first, then representative frames, then `poster_path`, then on-demand ffmpeg fallback (`docs/design-studio-feedback-loop.md:237-245`, `docs/design-studio-feedback-loop.md:506-509`).
- Implementation order: `existingRepresentativeFrame`, `existingPoster`, `existingKeyFrame`, then fallback (`apps/macos-studio/Sources/VideoOSStudioCore/ProjectThumbnailCache.swift:4-18`).
- `key_frame_path` exists in the search response contract (`runtime/tools/footage-search.ts:161-172`) and is populated from matched frame / frame path / filmstrip path (`runtime/tools/footage-search.ts:1998-2008`).

Impact:

Candidate cards may show lower-value generic representative/poster images even when the visual search key frame exists. This breaks the intended "reuse search evidence first" behavior of Phase 2.

Recommended fix:

Reorder `ProjectThumbnailCache.thumbnailURL` to key frame first, then representative frame, then poster, then cache fallback. If candidate-level `key_frame_path` is expected, add it to `read-candidates.ts` output and pass it into thumbnail resolution instead of only searching asset metadata / trace JSON.

### [Concern] Fallback refs are not composed into the alternatives list

Evidence:

- Design says data composition includes primary candidates by matching `eligible_beats`, plus `candidate_plan.fallback_candidate_refs` for the current beat (`docs/design-studio-feedback-loop.md:229-232`).
- `CandidateBrowserDataSource.fallbacks(forBeat:)` returns refs, but `candidates(forBeat:)` only filters by `eligible_beats` and sorts by confidence (`apps/macos-studio/Sources/VideoOSStudioCore/CandidateBrowserDataSource.swift:49-62`).
- `CandidateSwapView.alternatives` uses `dataSource.candidates(forBeat:)`, then only badges candidates whose IDs appear in fallback refs (`apps/macos-studio/Sources/VideoOSStudio/CandidateSwapView.swift:27-31`, `apps/macos-studio/Sources/VideoOSStudio/CandidateSwapView.swift:143-149`).

Impact:

A candidate listed in `fallback_candidate_refs` but missing the current beat in `eligible_beats` will not appear. The implementation therefore treats fallback refs as metadata, not as a fallback source.

Recommended fix:

Compose alternatives from both sources: eligible candidates sorted by confidence, then fallback refs resolved by `candidate_id` or `segment_id`, de-duplicated. Preserve planned fallback order or explicitly document that confidence sorting wins.

### [Concern] Subprocess and YAML failures are indistinguishable from valid empty data

Evidence:

- Missing planning artifacts throw in `readYaml` (`scripts/read-candidates.ts:124-128`).
- `CandidateBrowserDataSource.load` returns `empty(projectID:)` on non-zero exit, thrown errors, and JSON decode failures (`apps/macos-studio/Sources/VideoOSStudioCore/CandidateBrowserDataSource.swift:24-45`).
- The view shows "No Alternatives" when alternatives are empty (`apps/macos-studio/Sources/VideoOSStudio/CandidateSwapView.swift:133-139`).

Impact:

If `selects_candidates.yaml` or `edit_blueprint.yaml` is missing, the operator sees the same empty-state UX as a real project with no candidates. This makes setup/data failures hard to diagnose.

Recommended fix:

Return a load result that preserves `exitCode`, `stderr`, and a user-facing error. Keep the fail-open empty list if desired, but expose "Candidate data failed to load" separately from "No candidates are eligible."

### [Concern] Subprocess runner is only partially aligned with existing runner pattern

Evidence:

- Existing runners expose a typed `Runner` injection seam and convert `SubprocessRunner.Output` into domain results (`apps/macos-studio/Sources/VideoOSStudioCore/ProjectRoughCutCompileRunner.swift:154-201`, `apps/macos-studio/Sources/VideoOSStudioCore/ProjectAnalysisRunner.swift:201-245`).
- `CandidateBrowserDataSource.load` directly invokes `SubprocessRunner.run` inside `Task.detached` and cannot be unit-tested without launching `npx` (`apps/macos-studio/Sources/VideoOSStudioCore/CandidateBrowserDataSource.swift:24-45`).

Impact:

The critical process boundary is not covered by Swift tests, and future failures will be harder to inspect from the Studio UI.

Recommended fix:

Add a small `CandidateBrowserLoadResult` / runner-injection layer matching the compile/analyze runner pattern, then test success, non-zero exit, stderr, and malformed JSON.

## Confirmed Passes

- `read-candidates.ts` reads `04_plan/selects_candidates.yaml` and `04_plan/edit_blueprint.yaml`, normalizes optional fields, and emits Swift-decodable JSON (`scripts/read-candidates.ts:94-121`, `scripts/read-candidates.ts:131-177`).
- The YAML shape is type-aligned through `runtime/artifacts/types.ts`, which re-exports the compiler artifact types (`runtime/artifacts/types.ts:1-5`, `runtime/artifacts/types.ts:24-35`).
- The "Use This" button creates a valid `replace_segment` operation (`apps/macos-studio/Sources/VideoOSStudio/CandidateSwapView.swift:181-188`; schema fields in `schemas/review-patch.schema.json:23-40`, `schemas/review-patch.schema.json:93-95`).
- The ffmpeg fallback writes to user cache, not the project (`apps/macos-studio/Sources/VideoOSStudioCore/ProjectThumbnailCache.swift:64-104`, `apps/macos-studio/Sources/VideoOSStudioCore/ProjectThumbnailCache.swift:129-137`).
- The sheet data flow is coherent: timeline context menu opens the browser, `StudioViewModel` loads candidate data, and `ContentView` switches from loading to `CandidateSwapView` (`apps/macos-studio/Sources/VideoOSStudio/TimelineViews.swift:239-249`, `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1802-1821`, `apps/macos-studio/Sources/VideoOSStudio/ContentView.swift:40-55`).
