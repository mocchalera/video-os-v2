# Source Bin collection order story drafted

## Findings

- `F-0019` should be framed around a focused editor goal: named Source Bin collections need a deliberate, persistent display order once editors create bins such as replacement candidates, B-roll review, hold, or selected takes.
- The story should not imply canonical artifact mutation. The accepted behavior stays local to macOS Studio collection state and must preserve `timeline.json`, review patch schema, compiler schema, source media, source monitor, quick insert, drag/drop, favorites, and work bin paths.
- The behavior should cover lifecycle edges because current collection management already supports create, rename, merge, delete, status, notes, filter, row/tile toggles, and bulk visible add/remove.

## Evidence

- `F-0019` was created by `pcl feature add` as "Source Bin collection order management".
- `US-0003` was created by `pcl story draft --feature F-0019`.
- `apps/macos-studio/Sources/VideoOSStudio/MediaPanelViews.swift` contains the Source Bin collection picker, create/delete/filter, name, status, note, result count, and bulk visible action controls.
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift` owns project-scoped Source Bin collection persistence.
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectMediaSourceBinCollectionCatalog.swift` owns collection normalize, rename, delete, and metadata merge behavior.

## Recommended pcl Commands

- `pcl story draft --feature F-0019 --actor "macOS Studio editor" --goal "keep named Source Bin selection collections in a deliberate editorial order" --benefit "so replacement, B-roll, hold, and review bins stay scannable across create, rename, delete, and project reopen flows" --expected-behavior "The Source Bin collection picker and related controls expose a stable project-scoped collection order. Creating, renaming, merging, deleting, selecting, filtering, adding/removing assets, changing status, and editing notes preserve that order unless the editor explicitly reorders it. Timeline artifacts, review patch schema, compiler schema, source monitor state, quick insert, drag/drop, favorites, and work bin behavior remain unchanged."`
