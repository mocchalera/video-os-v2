# macOS Studio decomposition plan

Status: implementation-ready
Owner task: `T-0041`
Started: 2026-07-11

## Current handoff

`T-0006` completed the first behavior-preserving view extraction. The next
slice is tracked separately as ready task `T-0041`: extract
`ProjectLibraryStore` behind `StudioViewModel` forwarding properties.

Scope boundaries:

- move repository root, project scan/init, and selected-project identity only;
- keep `StudioViewModel` as composition root and compatibility facade;
- do not move timeline editing, media browsing, agent jobs, or render execution;
- do not change canonical artifact schemas, UserDefaults keys, accessibility
  identifiers, or visible behavior.

Required verification:

- focused `ProjectLibraryStore` tests;
- `swift test` from `apps/macos-studio`;
- `swift build --target VideoOSStudio`;
- `./script/build_and_run.sh --verify`;
- `git diff --check`.

## Objective

Reduce the change radius of the macOS Studio without changing the editorial
artifact contracts or the visible editing behavior. `StudioViewModel` remains
the compatibility facade while feature state and cohesive timeline visual
layers move behind explicit boundaries.

The starting point is:

- `StudioViewModel.swift`: 8,597 lines
- `TimelineViews.swift`: 9,057 lines

This is an incremental decomposition, not a rewrite. Each slice must compile,
preserve accessibility identifiers and command routing, and pass the macOS
Studio test suite before the next slice begins.

## Target boundaries

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `ProjectLibraryStore` | repository root, project scan/init, selected project identity | timeline editing or render execution |
| `TimelineEditingStore` | in-memory timeline, selection, playhead, edit previews, patch/save state | media discovery or app-server jobs |
| `MediaBrowserStore` | evidence/candidates, source bin, source monitor, media resolution state | timeline persistence |
| `AgentJobStore` | app-server session, jobs, turns, approvals, agent status | deterministic timeline mutation |
| `RenderPackageStore` | analysis/compile/render/package run plans and statuses | editor interaction state |
| `SettingsStore` | persisted Studio preferences and defaults migration | project artifacts |
| Timeline view layers | rendering and interaction callbacks for one visual concern | project I/O or editorial policy |

The dependency direction is:

```text
VideoOSStudioCore
  -> feature stores
  -> StudioViewModel compatibility facade
  -> SwiftUI feature views
```

Feature stores do not import SwiftUI views. Views receive values, bindings, and
intent callbacks; they do not write canonical artifacts directly.

## Extraction sequence

1. Split behavior-preserving timeline visual layers from `TimelineViews.swift`.
   Start with audio overlays, then overview/ruler, edit toolbar, track row, and
   clip block groups.
2. Extract `ProjectLibraryStore` behind forwarding properties on
   `StudioViewModel`. It is the smallest store boundary with limited coupling to
   timeline interaction state.
3. Extract `SettingsStore`, keeping the current UserDefaults keys and defaults
   unchanged.
4. Extract `AgentJobStore` and `RenderPackageStore`; keep all process execution
   and artifact writes routed through existing Core runners.
5. Extract `MediaBrowserStore`, then `TimelineEditingStore` last because it has
   the widest interaction surface.
6. Remove forwarding code only after call sites and observable-state behavior
   have dedicated coverage.

## First completed slice

`TimelineWaveformOverlay` and `TimelineAudioCueOverlay` now live in
`TimelineAudioOverlayViews.swift`. Their layout, colors, help text,
accessibility identifiers, and call sites are unchanged. The shared
`timelineAccessibilitySuffix` helper is module-internal so extracted timeline
view files can preserve the existing identifiers.

After this slice, `TimelineViews.swift` is 8,966 lines and the extracted layer
is 93 lines.

## Per-slice acceptance checks

- no changes to timeline, review patch, compiler, or project artifact schemas;
- no changes to UserDefaults keys during view-only slices;
- `swift test` passes from the repository root;
- `swift build --target VideoOSStudio` passes;
- existing accessibility identifiers and visible copy remain stable;
- the extracted file has one cohesive feature responsibility;
- Project Control Loop evidence records the commands and changed files.

The next implementation slice is `ProjectLibraryStore` under ready task
`T-0041`, with `StudioViewModel` retained as the composition root and
compatibility facade.
