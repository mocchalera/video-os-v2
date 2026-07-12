# macOS Studio decomposition — slice 1

Date: 2026-07-11 JST  
Project Control Loop task: `T-0006`

## Outcome

The macOS Studio decomposition has a committed implementation plan and its
first behavior-preserving view extraction.

- Moved `TimelineWaveformOverlay` and `TimelineAudioCueOverlay` from
  `TimelineViews.swift` to `TimelineAudioOverlayViews.swift`.
- Preserved their call sites, visual properties, help text, and accessibility
  identifiers.
- Changed `timelineAccessibilitySuffix` from file-private to module-internal so
  extracted timeline view files share the existing identifier normalization.
- Added `docs/project-memory/macos-studio-decomposition-plan.md` with target
  store/view boundaries, dependency direction, extraction order, and per-slice
  acceptance checks.

No timeline, review patch, compiler, project artifact, or UserDefaults contract
changed.

## Size evidence

| File | Before | After |
| --- | ---: | ---: |
| `StudioViewModel.swift` | 8,597 | 8,597 |
| `TimelineViews.swift` | 9,057 | 8,966 |
| `TimelineAudioOverlayViews.swift` | 0 | 93 |

## Verification

```text
swift build --target VideoOSStudio
Build of target: 'VideoOSStudio' complete.

swift test
Executed 520 tests, with 0 failures (0 unexpected).

swift run videoos-studio-cli doctor
Build of product 'videoos-studio-cli' complete.
Video OS Studio
repo: /Users/mocchalera/Dev/video-os-v2-spec
projects: 29
codex app-server: cwd=/Users/mocchalera/Dev/video-os-v2-spec codex app-server --listen stdio://

git diff --check
PASS
```

## Next slice

Extract `ProjectLibraryStore` behind forwarding properties on
`StudioViewModel`, leaving the view model as the composition root and
compatibility facade while the migration is in progress.
