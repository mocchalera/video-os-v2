# Phase 1 Studio Feedback Loop Implementation Review

Date: 2026-06-22

Overall verdict: **Fail** until the patch-application failure path and undo restore path are made atomic/recoverable. The schema alignment work is mostly correct, but there is one compiler contract mismatch for `add_note`, and the current apply path can leave a modified `timeline.json` with no history record or undo path after a failed patch run.

## Verification Performed

- Pass: `swift test --filter 'ReviewPatchDocumentTests|StudioFeedbackSessionTests|PatchHistoryIndexTests'`
  - 13 tests passed.
- Pass: `swift build --target VideoOSStudio`
- Pass: representative Swift-shaped patch JSON validated with `Ajv2020` against `schemas/review-patch.schema.json`.
- Pass: `insert_segment` with `with_segment_id` was accepted by `runtime/compiler/patch.ts` when a matching candidate exists.
- Fail reproduced: `add_note` encoded without `new_timeline_in_frame` is rejected by `applyPatch()` with `Missing new_timeline_in_frame for marker`.

## Findings

### 1. ReviewPatchDocument JSON schema/runtime compatibility: **Fail**

Most operations serialize to the schema keys in `schemas/review-patch.schema.json` and are compatible with `runtime/compiler/patch.ts`. The exception is `add_note`.

- `apps/macos-studio/Sources/VideoOSStudioCore/ReviewPatchDocument.swift:147-151` encodes `add_note` with `op`, `target_clip_id`, `label`, and `reason`, but no `new_timeline_in_frame`.
- `runtime/compiler/patch.ts:206-209` dispatches `add_note` to `opAddMarker(...)`.
- `runtime/compiler/patch.ts:395-403` requires `new_timeline_in_frame` for both marker and note handling.

This means Swift can emit schema-valid `add_note` JSON that the compiler rejects. Fix by choosing one contract:

- Preferred for Phase 1: do not emit `add_note` from Studio until the compiler contract is extended, and remove/disable the Swift `addNote` operation from compiler-bound patch serialization.
- Or extend `add_note` to include `new_timeline_in_frame` and update Swift tests/schema docs accordingly.
- Or change `runtime/compiler/patch.ts` so `add_note` attaches to `target_clip_id` without requiring a marker frame.

Add an integration test that feeds every Swift-emitted operation shape into `applyPatch()`, not only a schema-shape helper.

### 2. `insert_segment` `segment_id` to `with_segment_id`: **Pass**

The Swift public case names the value `segment_id`, but encodes/decodes it as `with_segment_id`.

- `apps/macos-studio/Sources/VideoOSStudioCore/ReviewPatchDocument.swift:63-70`
- `apps/macos-studio/Sources/VideoOSStudioCore/ReviewPatchDocument.swift:125-132`
- `runtime/compiler/patch.ts:303-316`

This matches the live compiler contract. The runtime candidate lookup is keyed by `with_segment_id`, and a representative `insert_segment` patch applied successfully.

### 3. `add_marker` frame/kind mapping: **Concern**

The schema-compatible field mapping is correct: Swift encodes `frame` as `new_timeline_in_frame` and maps `kind` into the required `reason` field.

- `apps/macos-studio/Sources/VideoOSStudioCore/ReviewPatchDocument.swift:142-146`
- `schemas/review-patch.schema.json:18-21`
- `schemas/review-patch.schema.json:50-60`

However, `runtime/compiler/patch.ts` does not preserve arbitrary marker kind from the patch:

- `runtime/compiler/patch.ts:206-209` passes hardcoded `"review"` for `add_marker`.
- `runtime/compiler/patch.ts:405-409` writes marker `kind` from that hardcoded value and uses `label ?? reason` only for the label.

So `kind -> reason` is schema-valid but semantically lossy. If Studio only creates review markers, this is acceptable. If non-review kinds are expected, extend the schema/runtime to carry `kind`, or rename the Swift parameter so it is clear that it is a reason/category string, not persisted marker kind.

### 4. StudioFeedbackSession separation: **Pass**

`StudioFeedbackSession` owns pending operations, approval/rejection sets, baseline metadata, conflict detection, serialization, and history loading/pruning without importing UI frameworks.

- `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:18-27`
- `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:57-71`
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1562-1678`

`StudioViewModel` still orchestrates filesystem writes, compiler execution, alerts, and refresh. That boundary is appropriate for Phase 1.

### 5. `captureBaseline` hash consistency: **Pass**

Loaded timelines now carry a raw-file hash computed with the same helper used by `ProjectPlaybackContractStatus`.

- `apps/macos-studio/Sources/VideoOSStudioCore/TimelineDocument.swift:151-162`
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectPlaybackContractStatus.swift:98-103`
- `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:123-125`

The fallback hash in `StudioFeedbackSession.swift:173-190` is not byte-identical to the playback contract, but it is only used for constructed in-memory timelines without `sourceHash`. That is acceptable.

### 6. Conflict detection coverage: **Pass**

The implementation covers the requested cases:

- approve + reject: `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:76-84`
- remove + replace / remove + trim: `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:92-108`
- approved + remove: `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:110-117`

Test coverage is thinner than the implementation. See item 11.

### 7. `applyStudioPatch` flow safety: **Fail**

The high-level order exists: conflict check, baseline serialization, patch write, backup, compiler run, history append, prune, refresh. The failure path is not safe.

- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1604-1611` writes the patch and backup before checking `plan.canRun`.
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1619-1621` returns on not-runnable after leaving an orphan patch and backup with no history record.
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1638-1646` returns on nonzero compiler exit without restoring the backup and without recording history.
- `scripts/compile-timeline.ts:213-224` can write a partially patched `timeline.json` even when `result.errors.length > 0`, as long as at least one op was applied.
- `scripts/compile-timeline.ts:247-255` can exit 1 after writing the patched timeline if post-patch validation fails.

This can leave `timeline.json` changed, the UI reporting failure, and no `PatchHistoryRecord`, so `undoLastPatch()` cannot restore it.

Fix proposal:

- Build and validate `ProjectRoughCutCompilePlan` before writing the Studio patch/backup.
- On any compiler nonzero exit or thrown error after backup creation, restore `timeline.json` from the backup before returning.
- Prefer changing `scripts/compile-timeline.ts --patch` to fail before writing if any patch op errors, or add a dry-run/preflight path.
- Record failed patch attempts separately, or delete orphan patch/backup files on pre-compile failure.

### 8. `rebuildIndex: false`: **Pass**

The Studio apply path passes `rebuildIndex: false` explicitly.

- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1638-1640`
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectRoughCutCompileRunner.swift:175-177`

The runner only rebuilds the SQLite index when the flag is true, so this is wired correctly.

### 9. `undoLastPatch` timeline restore safety: **Fail**

Undo restores the last backup, but it is not atomic and does not protect against overwriting newer timeline changes.

- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1697-1710` removes the current `timeline.json` before copying the backup. If the copy fails, the current timeline is lost.
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1697-1710` does not compare the current timeline hash with `record.result_timeline_hash` before restoring. A user or process can modify `timeline.json` after the Studio patch, and undo will still overwrite it.

Fix proposal:

- Compute current `timeline.json` hash and require it to match `record.result_timeline_hash` before undo. If it does not match, show a stale/unsafe undo warning.
- Restore atomically via temp file plus `FileManager.replaceItemAt(...)`, or copy backup to a temp path and rename only after the copy succeeds.
- Keep a pre-undo emergency backup until the replace succeeds and playback refresh completes.

### 10. `pruneHistory` 20-backup retention: **Pass**

Retention keeps metadata records, deletes the oldest active backup files, and marks those records `purged`.

- `apps/macos-studio/Sources/VideoOSStudioCore/PatchHistoryIndex.swift:35-52`
- `apps/macos-studio/Sources/VideoOSStudioCore/StudioFeedbackSession.swift:132-140`
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1665-1667`

Default `maxBackups` is 20 and the app calls it with the default after successful apply. The test covers the mechanism with `maxBackups: 3`; add one default-20 test for the exact production limit.

### 11. Test coverage: **Concern**

Current tests are useful but not sufficient for the risk surface.

Covered:

- operation encode/decode and schema-key shape: `apps/macos-studio/Tests/VideoOSStudioCoreTests/ReviewPatchDocumentTests.swift:5-47`
- dedupe, one conflict case, serialize, baseline: `apps/macos-studio/Tests/VideoOSStudioCoreTests/StudioFeedbackSessionTests.swift:6-100`
- history round-trip and prune behavior: `apps/macos-studio/Tests/VideoOSStudioCoreTests/PatchHistoryIndexTests.swift:5-58`

Missing:

- real AJV validation against `schemas/review-patch.schema.json`
- direct `applyPatch()` acceptance tests for Swift-emitted JSON, especially `add_note`
- conflict tests for approve+reject and remove+trim
- default `pruneHistory` 20-backup behavior
- apply failure rollback test for partial patch / post-validation failure
- undo stale-hash and atomic-restore tests
- assertion that generated compiler patch JSON contains no absolute filesystem paths

### 12. File paths in `review_patch.json`: **Pass**

The Studio apply path writes only `envelope.patch`, not the metadata envelope or history record.

- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1587-1607`
- `apps/macos-studio/Sources/VideoOSStudioCore/StudioPatchEnvelope.swift:3-31`
- `apps/macos-studio/Sources/VideoOSStudioCore/PatchHistoryIndex.swift:75-83`

Patch/history file paths are stored in `PatchHistoryRecord`, not inside compiler-bound patch JSON. The generated Studio patch uses timestamped `06_review/studio_patch_*.json`, so it does not overwrite canonical `06_review/review_patch.json`.

Add a unit test that serializes a Studio patch and asserts no value contains `projectURL.path`, `/Users/`, or `file://`.
