# Source workflow and visible interaction surfaces mapped

## Findings

- Existing PCL features `F-0001` through `F-0018` cover macOS Studio publish/idempotence and selection normalization slices. None of them represents the next larger post-checkpoint source workflow or visible interaction residual.
- The checkpoint review recommends either closing the remaining Human Confirmation Queue visible interaction checks or starting a larger M8-style media browser/source monitor slice. Computer Use is currently unavailable in this Codex runtime, so the safer implementation candidate is a source workflow feature that can be covered with Swift tests and app launch verification.
- Source Bin named collections are already implemented with create, rename, delete, filter, status, note, row/tile membership, bulk visible add/remove, favorite/work-bin independence, and UserDefaults-backed per-project state. The next concrete user-visible gap is collection ordering: editors can create several named bins, but there is no explicit preserved editorial ordering or reorder surface for those bins.
- A small next feature should keep the existing local-only state model, avoid `timeline.json`, review patch schema, compiler schema, source media, rendered outputs, and production config, and stay inside `apps/macos-studio`.

## Evidence

- `pcl feature list` shows only `F-0001` through `F-0018`, all done and scoped to macOS Studio publish/idempotence normalization.
- `reports/macos-studio-checkpoint-2026-07-01.md` recommends returning to direct native editing value after the approved checkpoint.
- `docs/project-memory/PLANS.md` lists M8 Media Browser and Source Monitor as the next source workflow candidate and still calls out nested folders and drag-reorder as future work.
- `docs/project-memory/CONTINUITY.md` keeps the Human Confirmation Queue separate from code-complete status and lists Source Bin/marked range visible checks as residual human validation.
- `apps/macos-studio/Sources/VideoOSStudio/MediaPanelViews.swift` exposes `MediaPanel.SourceBinCollectionPicker`, create/delete/name/status/note controls, row/tile toggles, and bulk visible add/remove controls.
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift` owns Source Bin collection state and UserDefaults-backed persistence.
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectMediaSourceBinCollectionCatalog.swift` owns collection metadata normalization, rename, delete, and merge behavior.

## Recommended pcl Commands

- `pcl feature add --name "Source Bin collection order management" --surface "apps/macos-studio" --description "Let editors preserve and adjust the display order of named Source Bin selection collections while keeping membership, status, notes, filters, source monitor, quick insert, drag, favorites, work bin, timeline.json, review patch schema, and compiler contracts unchanged." --evidence "reports/pcl-wr0020-mapper.md; docs/project-memory/PLANS.md M8 source workflow gap; MediaPanel Source Bin collection controls; ProjectMediaSourceBinCollectionCatalog"`
- `pcl feature add --name "Consolidated visible edit interaction verification" --surface "apps/macos-studio" --description "Run the Human Confirmation Queue visible interaction checks for clip drag, group lane lift, transition editing, toolbar density, Source Bin marked-range flows, and timeline navigation, recording failed or confusing behavior back into the canonical UX tracker and story notes." --evidence "reports/pcl-wr0020-mapper.md; docs/project-memory/CONTINUITY.md Human Confirmation Queue"`
- `pcl feature add --name "Timeline AI consultation evidence context" --surface "apps/macos-studio" --description "Expand timeline-scoped AI consultation prompts with clip evidence, QA issues, transcript, Marlin, audio-story, and current timeline context while keeping AI output previewable and read-only until explicit apply." --evidence "reports/pcl-wr0020-mapper.md; docs/project-memory/PLANS.md M7 AI-Assisted Edit Bench"`
