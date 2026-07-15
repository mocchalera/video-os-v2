# Plans

## Current Objective

Make RoughCut Agent feel like a credible native editing workstation, not only an artifact dashboard: an editor should be able to review, play, search, replace, annotate, trim, and package a rough cut inside the macOS app while AI remains an inspectable collaborator.

## Current Phase

Pro-grade native editing core — preserve the existing artifact-driven pipeline and AI feedback loop, but raise macOS Studio toward the baseline feel of professional video editing software.

The oversized macOS Studio files now have an incremental split plan in
[`macos-studio-decomposition-plan.md`](macos-studio-decomposition-plan.md).
The first behavior-preserving timeline visual layer extraction is complete;
store extraction proceeds behind the existing `StudioViewModel` facade.

## 2026-07-10 Productization Priority Checkpoint

The completed M6/M6.5 editing capability is preserved, but net-new Studio feature
expansion is no longer the top priority. The cross-repository P0 is now to prove one
speech-led product route without adding a parallel pipeline or artifact model:

1. restore all six CI responsibility jobs to green;
2. freeze `interview-highlight` as the first-run 60–180 second product contract;
3. promote one rights-cleared, human-approved speech-led golden project;
4. prove brief → analysis → story → cut → review → Studio edit → NLE export through
   the existing state machine and runtime pipeline;
5. gate regressions with editor-effort and post-export revision metrics.

Existing M6.5 work remains valid product capability. New feature slices should be
limited to blockers found by this golden path until the P0 gates are complete. See
`docs/video-os-v2-productization-audit-20260710.md` for the live audit, artifact
mapping, and acceptance criteria.

Gate 0 completed on 2026-07-10. GitHub Actions run `29073236878` passes all six
responsibility jobs on commit `08a39f53`, including hosted macOS 14 / Apple Swift
5.10 and clean Node 22 media integration tests. The active P0 now moves to item 2:
freeze and prove the `interview-highlight` 60–180 second product contract. See
`reports/ci-baseline-repair-20260710.md`.

Gate 1 completed on 2026-07-10. The normative contract is
`docs/speech-led-highlight-product-contract.md`: the first-run route is fixed to
`interview-highlight` / `interview`, actual output duration is 60–180 seconds, and
input, output, degraded behavior, exclusions, state/artifact authority, and product
metrics all reuse existing contracts. The active P0 now moves to item 3: establish
one rights-cleared, operator-approved speech-led golden.

Gate 2 completed on 2026-07-10. `lively-alt-vol5` timeline v2 is rights-confirmed,
operator-approved, and discovered as a human-tier golden. The approved local render
is 91.208 seconds with Japanese captions, -15.8 LUFS audio, and an evidence-backed
alternate angle in the closing run. Private source/renders remain untracked, and
automated Marlin QA remains fail-closed after a real-model timeout. The active P0 now
moves to item 4 / T-0013: prove the resumable brief-to-NLE E2E route.

Gate 3 completed on 2026-07-10. The operator-approved 60 px v3 resumed after a PC
restart without re-analysis, reached stable `packaged` state with no stale
artifacts, passed real package QA, rendered a 24 fps Studio exact preview from the
same 18 approved captions, and round-tripped all 12 Premiere XML clipitems with zero
diff. The next P0 work is outcome metrics plus T-0015/T-0016 product exposure and
mandatory regression. Evidence is in
`reports/project-control-loop/2026-07-10-speech-led-resumable-e2e.md`.

## Current Implementation Snapshot

- The TypeScript pipeline owns canonical artifacts, deterministic compile, render/package commands, QA loop, footage DB/search, Qwen3-VL/CLAP/Marlin fail-open paths, and Premiere XML/editor packet handoff.
- macOS Studio already has a three-zone workspace: Viewer, Timeline, and right-side Inspector surfaces for Agent, Project, Clip, Media, and QA.
- Viewer supports timeline/source preview, source monitor mode from the Media panel, play/pause, reverse/forward shuttle, step controls, selected-clip loop/range playback, lightweight unsaved crossfade preview, audio mute/volume, playback rate badges, playback contract badges, diagnostics, and timeline-preview awareness.
- Timeline supports track rows with kind-aware headers, marker lane labeling, markers, audio cues, waveform overlays, playhead scrubbing with magnetic edit-point/marker/timeline-boundary snap, timeline overview role legend, role-colored clip badges, single/multi clip selection, context menus, pending feedback highlights, selected-clip drag trim handles with drag-time visual preview, magnetic trim snap, trim delta feedback, and immediate in-memory display, clip-body magnetic drag move with same-track overlap displacement, lane-lift/target-track move previews, blocked target cues, transition preset drag/drop targets with idle landing guides, drop-hover Viewer preview, visible duration grips, selected-transition 0.5s duration nudges from toolbar, Command Palette, and timeline-focus shortcuts, and applied-transition central drag relocation to another edit point, timeline zoom/fit controls, source candidate drag/drop insertion with marked source ranges, source-bin row quick drag through the best candidate with a visible candidate/target/duration cue, source-bin row quick insert at the playhead, drag-time ghost duration/blocked-lane feedback, magnetic source-drop snap, and overlap lane-lift to open/new compatible lanes, and a visible grouped icon-first selected-clip edit toolbar for approve/reject, bulk approve/reject, ripple delete, fixed trim, playhead trim, split at playhead, roll trim, slip trim, extend trim, swap, search, apply, and undo.
- AI/editing support exists through Codex App Server sessions, job approvals, RAG context, clip annotation proposals, QA dashboard, review patch apply/undo/promote, candidate browser, and visual/audio footage search.
- Current gap: the first direct-editing slice, patch-based ripple delete, playhead-aware trim, true split-at-playhead, inward drag trim, clip-body magnetic drag move, transition preset drag/drop and active drag status, selected-transition remove-to-cut, applied-transition drag relocation, source monitor preview, source-monitor insert at playhead, source-monitor candidate selection, source-monitor marked insert/drop range, source candidate drag-time ghost, source-bin row quick drag with candidate cue, source-bin row quick insert at playhead, source-bin compact filter menu, Source Bin thumbnail browsing, magnetic drop snap, and overlap lane-lift, source-monitor marked selected-clip replace, source-monitor marked overwrite including middle-split remainders and pre-click range/impact preview, multi-select bulk approve/reject, focus-gated transport shortcuts, reverse/forward shuttle playback, selected-clip loop/range playback, timeline zoom/fit controls, timeline role color semantics, timeline track/marker header semantics, grouped icon-first edit toolbar density, fixed 0.5s roll trim, fixed 0.5s slip trim, fixed 0.5s extend trim, and the first Media-panel source monitor/bin preview workflow are in place, but the app is not yet a full NLE. Named bins and deeper source workflow polish remain M8-sized work.

## Next Milestone Candidates

### Recommended: M6 — Pro Editing Core

Goal: make the macOS app capable of basic rough-cut editing without leaving the app, while every edit remains representable as deterministic review/studio patch operations.

- [x] Define the first editing interaction contract: selected clip toolbar, disabled/unselected state, non-destructive patch operations, and apply/undo lifecycle through existing review/studio patch contracts.
- [x] Add first visible timeline controls: approve/reject, trim start/end, swap, search, apply, undo, selected clip summary, and clear visual states for pending trim edits.
- [x] Make the first direct edits flow through `StudioFeedbackSession` / `ReviewPatchDocument` first, then compile/preview/promote through the existing deterministic pipeline.
- [x] Add patch-based ripple delete using `remove_segment` plus same-track downstream `move_segment` operations.
- [x] Add playhead-aware trim using `trim_segment` plus duration-aware `move_segment` operations.
- [x] Resolve true split-at-playhead through an explicit patch/compiler contract rather than unsafe candidate insertion.
- [x] Add draggable trim handles for selected clips, backed by existing trim/move patch operations.
- [x] Add clip-body drag move with magnetic snap to edit points, playhead, markers, timeline start, and downstream same-track displacement when clips overlap.
- [x] Add transition preset drag/drop onto adjacent video edit points through an explicit `set_transition` patch contract.
- [x] Make manual clip drag and transition drop update the visible timeline immediately instead of behaving like AI-review patch preview.
- [x] Make unsaved manual clip drag playback follow the in-memory timeline source clip instead of stale rough-cut preview playback.
- [x] Add initial transition selection and horizontal drag duration adjustment.
- [x] Add lightweight unsaved crossfade preview in Viewer so transition duration drag changes the visible fade range before save/update.
- [x] Add multi-selection for bulk approve/reject while keeping single-clip trim/split/swap operations guarded.
- [x] Add first NLE-grade roll trim controls for adjacent edit points, preserving gapless patch preview through existing trim/move operations.
- [x] Add slip trim controls for shifting a selected clip's source range while preserving its timeline position and duration.
- [x] Add extend trim behavior and clear visual states for each pending edit type.
- [x] Add the first source/bin workflow slice: Media-panel source preview buttons, source monitor Viewer state, explicit return to Program preview, and timeline selection as a context switch back to Program.
- [x] Upgrade playback ergonomics: focus-gated J/K/L transport, 1-frame step behavior, reliable timeline-preview playback smoke, and visible timecode/selection feedback.
- [x] Add reverse/forward shuttle playback and visible playback speed feedback for J/K/L-style pro transport, while keeping `,` / `.` as one-frame step controls.
- [x] Add selected-clip loop/range playback for repeated cut review, with `R`, Transport, Command Palette, and playback boundary wrapping.
- [x] Add timeline zoom/fit controls for overview vs detail editing, with visible controls, Command Palette, View menu, and focus-gated shortcuts.
- [x] Consolidate the CapCut/FCPX/Premiere benchmark trace for the current M6 editing controls and link it to the canonical UX tracker.
- [x] Complete the M6 requirement-by-requirement audit and document the M8/M9 scope boundary.
- [x] Verify the first direct-edit slice with Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify ripple delete with Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify playhead-aware trim with Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify split at playhead with TS compiler/schema coverage, Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify drag trim with Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify magnetic clip drag move and transition drop with Swift unit coverage, full Swift tests, TypeScript typecheck, Vitest compiler patch coverage, `build_and_run --verify`, and canonical tracker update.
- [x] Verify same-track overlap displacement and unsaved manual-edit playback source switching with focused Swift unit coverage.
- [x] Verify active transition preview range and `cut`-as-empty-edit-point behavior with focused Swift unit coverage.
- [x] Verify multi-select bulk approve/reject with Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify transport shortcut polish with Swift unit coverage, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify roll trim with Swift unit coverage, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify slip trim with Swift unit coverage, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify extend trim with Swift unit coverage, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify source monitor/bin preview with `ProjectMediaResolverTests`, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify reverse/forward shuttle playback with Core transport tests, command palette tests, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify selected-clip loop/range playback with Core transport tests, command palette tests, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify timeline zoom/fit controls with Core viewport tests, command palette tests, full macOS Studio Swift tests, `build_and_run --verify`, and Computer Use visible-state smoke.
- [x] Verify the benchmark trace against current official source docs, Computer Use AX state, screenshot artifact, and canonical tracker validation.
- [x] Verify scoped M6 completion with current Swift/TS/Vitest/build_run checks, Computer Use visible-state smoke, and canonical tracker validation.
- [x] Verify the post-M6 manual edit visible smoke with CGEvent/Computer Use: drag a clip body into another clip and confirm the dragged clip stays while overlapped clips shift right, start playback and confirm it follows the dropped position, drop `クロスフェード` on a visible V1 `+` edit point, confirm the Viewer crossfade badge/overlay, and confirm `未保存` / `破棄` behavior.
- [x] Verify direct `保存して更新` button click on a disposable fixture. Computer Use remained blocked by AX/screen capture, so the final check used human operation on `projects/000-m6-save-update-human-20260626`; artifact readback confirmed timeline hash `4beac091ea8dce45` -> `6c63eef0c16f4bb8`, changed clip frames `0/279/639/978/1398` -> `12/291/651/990/1410`, preview manifest hash match, patch history `source=studio_ui`, and backup preservation.

### Active: M6.5 — Editing Feel / Magnetic UX

Goal: make the direct-edit loop feel closer to FCPX/CapCut by improving drag-time feedback, magnetic prediction, transition affordances, and Viewer response while preserving the existing safe patch/save lifecycle.

- [x] Start the M6.5 goal and split it by operation feel rather than feature checklist.
- [x] Add clip-body drag-time preview using the same `TimelineClipMovePlan` as drop commit, so snap and overlap displacement preview match the saved patch result.
- [x] Add visible snap indicator, target outline, and displaced-clip preview role for magnetic drag.
- [x] Build and launch the updated app with `swift build --target VideoOSStudio`, `swift test --filter TimelineClipMovePlanTests`, and `./script/build_and_run.sh --verify`.
- [x] Update canonical UX tracker and user-story docs with US-25 / UX-42 / TEST-50.
- [x] Add transition duration drag-time Viewer preview with transient in-memory transition state, preserving one patch commit on drag end.
- [x] Strengthen transition drop hover/target affordance and update canonical tracker/docs with UX-43 / TEST-51.
- [x] Add layered magnetic overlap behavior for video/overlay clip moves: drag-time lane lift preview, `move_segment.target_track_id`, Swift/TS compiler application, and stale transition cleanup.
- [x] Update canonical UX tracker and user-story docs with UX-44 / TEST-52.
- [x] Expand transition edit-point landing zones with visible rails and wider drop hit areas while preserving existing transition selection and duration drag.
- [x] Update canonical UX tracker and user-story docs with UX-45 / TEST-53.
- [x] Add grouped clip drag move for multi-selection, preserving relative offsets and displacing only unselected overlaps.
- [x] Update canonical UX tracker and user-story docs with UX-46 / TEST-54.
- [x] Share grouped drag preview state across timeline rows so cross-track multi-selection ghosts during drag.
- [x] Update canonical UX tracker and user-story docs with UX-47 / TEST-55.
- [x] Make drag trim update the in-memory timeline immediately, including source range, display duration, selection, and Viewer playback sync.
- [x] Update canonical UX tracker and user-story docs with UX-48 / TEST-56.
- [x] Add drag-time visual preview for trim handles using the same `TimelineDragTrimPlan` as drop commit.
- [x] Update canonical UX tracker and user-story docs with UX-49 / TEST-57.
- [x] Add magnetic snap, boundary line, and trim delta badge for drag trim handles.
- [x] Update canonical UX tracker and user-story docs with UX-50 / TEST-58.
- [x] Add transition preset drop-hover preview so the edit point and Viewer react before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-51 / TEST-59.
- [x] Add direct timeline ruler click/drag scrub so the playhead and Viewer follow without using the separate slider.
- [x] Update canonical UX tracker and user-story docs with UX-52 / TEST-60.
- [x] Add clip hover/selection/body-drag affordances so timeline clips visibly communicate drag readiness.
- [x] Update canonical UX tracker and user-story docs with UX-53 / TEST-61.
- [x] Add empty timeline-track background click/drag scrub so the playhead can be placed from the timeline surface, not only the ruler/slider.
- [x] Update canonical UX tracker and user-story docs with UX-54 / TEST-62.
- [x] Add magnetic snap for ruler/empty-lane playhead scrub so nearby edit points, markers, and timeline boundaries catch the playhead with a visible snap indicator.
- [x] Update canonical UX tracker and user-story docs with UX-55 / TEST-63.
- [x] Add idle transition landing guides and existing-transition duration grips so drop targets and adjustment handles remain visible before hover.
- [x] Update canonical UX tracker and user-story docs with UX-56 / TEST-64.
- [x] Add transition duration drag delta badges so existing transitions show frame delta, total frames, and seconds while being adjusted.
- [x] Update canonical UX tracker and user-story docs with UX-57 / TEST-65.
- [x] Add selected-transition summary in the timeline edit toolbar so transition selection does not look like an empty clip selection state.
- [x] Update canonical UX tracker and user-story docs with UX-58 / TEST-66.
- [x] Add passive clip-edge trim affordances so hover/selection reveals where IN/OUT drag trimming starts.
- [x] Update canonical UX tracker and user-story docs with UX-59 / TEST-67.
- [x] Add clip drag move HUD with frame/seconds delta, target lane, displacement count, and snap context during body drag.
- [x] Update canonical UX tracker and user-story docs with UX-60 / TEST-68.
- [x] Add existing-target-lane ghost/highlight for lane-lift clip moves so drag preview appears on the row where the clip will land.
- [x] Update canonical UX tracker and user-story docs with UX-61 / TEST-69.
- [x] Add transition drop magnet cue so preset hover shows the snapped edit point, preset, and from/to clips before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-62 / TEST-70.
- [x] Highlight all eligible empty edit points while a transition preset is being dragged, before the cursor reaches a specific target.
- [x] Update canonical UX tracker and user-story docs with UX-63 / TEST-71.
- [x] Add clip-body vertical target-track drag so compatible open tracks can be chosen directly during body drag.
- [x] Update canonical UX tracker and user-story docs with UX-64 / TEST-72.
- [x] Add blocked target cues for vertical clip drags that land on incompatible or occupied tracks.
- [x] Update canonical UX tracker and user-story docs with UX-65 / TEST-73.
- [x] Add accepted clip move landing cues so drag preview shows the exact drop rail, target track, and timecode before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-66 / TEST-74.
- [x] Add clip move drag-time Viewer preview so clip body drags update Viewer media, source time, and timecode before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-67 / TEST-75.
- [x] Add timeline track density control so editors can switch compact/standard/expanded vertical density independently from horizontal zoom/fit.
- [x] Update canonical UX tracker and user-story docs with UX-68 / TEST-76.
- [x] Add timeline overview strip and playhead locate scroll anchor so detail zoom does not hide whole-sequence context.
- [x] Update canonical UX tracker and user-story docs with UX-69 / TEST-77.
- [x] Add transition preset click-to-apply so users can apply a preset to the selected or playhead-nearest visual edit point without finding a drop target first.
- [x] Update canonical UX tracker and user-story docs with UX-70 / TEST-78.
- [x] Add source monitor insert-at-playhead so a previewed asset can become a timeline clip immediately through `insert_segment` while Timeline/Viewer update in memory.
- [x] Update canonical UX tracker and user-story docs with UX-71 / TEST-79.
- [x] Add source monitor candidate selection so the Media panel shows which select candidate will be inserted and lets editors step previous/next before adding.
- [x] Update canonical UX tracker and user-story docs with UX-72 / TEST-80.
- [x] Add selected-transition remove-to-cut so applied transitions can be removed from the toolbar while Timeline, Viewer, and compiler state stay aligned.
- [x] Update canonical UX tracker and user-story docs with UX-73 / TEST-81.
- [x] Add source-monitor selected-clip replace so the visible source candidate can replace the selected timeline clip immediately through existing `replace_segment`.
- [x] Update canonical UX tracker and user-story docs with UX-74 / TEST-82.
- [x] Add audio overlap lane lift so dragged audio clips reuse or create compatible A lanes instead of pushing downstream audio clips.
- [x] Update canonical UX tracker and user-story docs with UX-75 / TEST-83.
- [x] Add source candidate drag-to-timeline so source monitor candidate cards can be dropped onto compatible timeline lanes at a specific frame.
- [x] Update canonical UX tracker and user-story docs with UX-76 / TEST-84.
- [x] Add source candidate drag-time ghost so candidate card drags show marked-range duration, target timecode, and incompatible-lane blocked feedback before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-83 / TEST-91.
- [x] Add source candidate overlap lane-lift so drops over occupied compatible lanes preview and commit to an open or newly-created lane using the same `insert_segment target_track_id` contract.
- [x] Update canonical UX tracker and user-story docs with UX-84 / TEST-92.
- [x] Add source candidate magnetic drop snap so candidate-card drops catch nearby edit points, playhead, markers, or timeline start using the same preview/commit planner.
- [x] Update canonical UX tracker and user-story docs with UX-85 / TEST-93.
- [x] Add existing-transition drag relocation so an applied transition can be moved from one edit point to another with hover preview and immediate timeline commit.
- [x] Update canonical UX tracker and user-story docs with UX-86 / TEST-94.
- [x] Add source edit post-commit changed-clip highlights and keep source overwrite pinned to the chosen target track instead of lane-lifting like an insert.
- [x] Update canonical UX tracker and user-story docs with UX-87 / TEST-95.
- [x] Add a persistent thumbnail source-bin filter inside MediaPanel so source assets can be scanned by all/ready/video/audio/needs-action before source-monitor preview.
- [x] Update canonical UX tracker and user-story docs with UX-88 / TEST-96.
- [x] Add source-bin search and persistent sort controls so editors can find source assets by filename/ID/status and keep source order/name/status/kind ordering predictable.
- [x] Update canonical UX tracker and user-story docs with UX-89 / TEST-97.
- [x] Add selected-clip 0.5s nudge controls so editors can move one or more selected clips with toolbar buttons or `[` / `]` while using the existing magnetic move/lane-lift path.
- [x] Update canonical UX tracker and user-story docs with UX-90 / TEST-98.
- [x] Let clip edge drag trim both shorten and extend into available same-track gaps/source handles, with signed preview badges and immediate Timeline/Viewer update.
- [x] Update canonical UX tracker and user-story docs with UX-91 / TEST-99.
- [x] Add Blade mode so `B`, toolbar, or Command Palette toggles direct clip-click splitting at the clicked frame with immediate Timeline/Viewer preview.
- [x] Update canonical UX tracker and user-story docs with UX-92 / TEST-100.
- [x] Add timeline snapping toggle so `N`, toolbar, or Command Palette can disable/re-enable magnetic snap for drag, trim, scrub, and source drop operations.
- [x] Update canonical UX tracker and user-story docs with UX-93 / TEST-101.
- [x] Add timeline marquee range selection so Multi-select mode can select clips by dragging an empty track lane while normal empty-lane drag still scrubs.
- [x] Update canonical UX tracker and user-story docs with UX-94 / TEST-102.
- [x] Add timeline Command-A all-clip selection and Esc clear-selection/tool shortcuts so selection state can be created and reset without mouse-only cleanup.
- [x] Update canonical UX tracker and user-story docs with UX-95 / TEST-103.
- [x] Add Delete-key selected item removal so a selected clip ripple-deletes or a selected transition returns to cut, with single-clip ripple delete reflected in the timeline immediately.
- [x] Update canonical UX tracker and user-story docs with UX-96 / TEST-104.
- [x] Add same-track multi-selection ripple delete so marquee/Command-A-style selections can delete several clips on one track and immediately close their gaps with cumulative downstream moves.
- [x] Update canonical UX tracker and user-story docs with UX-97 / TEST-105.
- [x] Extend selected-range loop playback so `R` / Command Palette loops a multi-clip selection or the selected transition review range, not only one clip.
- [x] Update canonical UX tracker and user-story docs with UX-98 / TEST-106.
- [x] Add cross-track lift delete so `Delete` / Command Palette can remove selected clips across tracks without unsafe ripple movement.
- [x] Update canonical UX tracker and user-story docs with UX-99 / TEST-107.
- [x] Add source monitor current-time IN/OUT marking so editors can play or seek source media and mark the visible position through I/O controls or Command Palette.
- [x] Update canonical UX tracker and user-story docs with UX-100 / TEST-108.
- [x] Add focus-gated source monitor `I` / `O` shortcuts so current-time marks can be set from the keyboard without stealing timeline or text-field input.
- [x] Update canonical UX tracker and user-story docs with UX-101 / TEST-109.
- [x] Add a selected group-move range cue so multi-selected clip drags show the whole magnetic landing span, moved count, displacement count, and snap state.
- [x] Update canonical UX tracker and user-story docs with UX-102 / TEST-110.
- [x] Add same-track selected group vertical move so multiple selected clips can drag together to an open compatible target track while preserving timing.
- [x] Update canonical UX tracker and user-story docs with UX-103 / TEST-111.
- [x] Add selected group occupied-lane lift so same-track multi-selected clips drag over occupied compatible targets and land together on an open/new compatible track.
- [x] Update canonical UX tracker and user-story docs with UX-104 / TEST-112.
- [x] Add Q/W and Command Palette trim-to-playhead so selected clip starts/ends trim to the playhead and Timeline/Viewer update immediately before save.
- [x] Update canonical UX tracker and user-story docs with UX-105 / TEST-113.
- [x] Add immediate toolbar trim suite so fixed 0.5s trim, roll, extend, and slip update Timeline/Viewer before save.
- [x] Update canonical UX tracker and user-story docs with UX-106 / TEST-114.
- [x] Add source-bin row quick drag so a ready media row can put its best unused select candidate onto the timeline through the existing magnetic source-drop path.
- [x] Update canonical UX tracker and user-story docs with UX-107 / TEST-115.
- [x] Add source-bin quick-drag candidate cue so ready rows reveal the candidate segment, role, default target track, duration, and confidence before drag.
- [x] Update canonical UX tracker and user-story docs with UX-108 / TEST-116.
- [x] Add source-bin quick insert so a ready row can add the visible best candidate at the playhead without opening the source monitor or dragging.
- [x] Update canonical UX tracker and user-story docs with UX-109 / TEST-117.
- [x] Add selected-transition 0.5s duration nudge controls so an applied transition can be shortened/lengthened from the toolbar with immediate Timeline/Viewer feedback.
- [x] Update canonical UX tracker and user-story docs with UX-110 / TEST-118.
- [x] Add Command Palette entries and timeline-focus `Shift-[` / `Shift-]` shortcuts for selected-transition duration nudges.
- [x] Update canonical UX tracker and user-story docs with UX-111 / TEST-119.
- [x] Add FCPX-like default crossfade apply through Command Palette and timeline-focus `Command-T`.
- [x] Update canonical UX tracker and user-story docs with UX-112 / TEST-120.
- [x] Mark the default crossfade preset in the transition palette with a command-key affordance and accessibility hint.
- [x] Update canonical UX tracker and user-story docs with UX-113 / TEST-121.
- [x] Add multi-selection range summary in the timeline edit toolbar so group edits show selected tracks, range, and duration before action.
- [x] Update canonical UX tracker and user-story docs with UX-114 / TEST-122.
- [x] Enable toolbar ripple delete for same-track multi-selection while keeping cross-track ripple disabled.
- [x] Update canonical UX tracker and user-story docs with UX-115 / TEST-123.
- [x] Add visible toolbar delete action that reuses the existing safe delete path while keeping ripple delete visually distinct.
- [x] Update canonical UX tracker and user-story docs with UX-116 / TEST-124.
- [x] Persist timeline zoom, fit-to-window, and track density preferences so repeated editing sessions keep the editor's working view.
- [x] Update canonical UX tracker and user-story docs with UX-117 / TEST-125.
- [x] Persist source-bin search query and source monitor asset/candidate context so source selection can resume after app restart.
- [x] Update canonical UX tracker and user-story docs with UX-118 / TEST-126.
- [x] Add source-bin smart bin grouping so filtered/search results can be browsed by folder, playback status, or media kind.
- [x] Update canonical UX tracker and user-story docs with UX-119 / TEST-127.
- [x] Add Source Monitor edit action shortcuts and Command Palette entries so insert, overwrite, and replace can be triggered with focus-gated W/D/R.
- [x] Update canonical UX tracker and user-story docs with UX-120 / TEST-128.
- [x] Add Source Monitor append-to-end shortcut and Command Palette entry so FCPX-like E append can add the marked source range at the sequence tail.
- [x] Update canonical UX tracker and user-story docs with UX-121 / TEST-129.
- [x] Add project-scoped source-bin favorites so editors can star source assets and filter the media shelf without changing timeline or patch artifacts.
- [x] Update canonical UX tracker and user-story docs with UX-122 / TEST-130.
- [x] Add aligned cross-track ripple delete so clips selected across V/A/O tracks covering the same time range can close that range magnetically instead of always lift-deleting.
- [x] Update canonical UX tracker and user-story docs with UX-123 / TEST-131.
- [x] Add source-bin used/unused filters and used badges so editors can separate already-used timeline assets from unused source material after AI rough assembly.
- [x] Update canonical UX tracker and user-story docs with UX-124 / TEST-132.
- [x] Add source-bin usage grouping so editors can browse unused and timeline-used media in one material shelf without switching filters.
- [x] Update canonical UX tracker and user-story docs with UX-125 / TEST-133.
- [x] Replace the crowded source-bin segmented filter with a compact filter menu and visible selected-condition summary so media browsing does not clip in the narrow panel.
- [x] Update canonical UX tracker and user-story docs with UX-126 / TEST-134.
- [x] Add active transition preset drag status so the palette highlights the carried preset and shows a compact toolbar status while edit-point landing guides are active.
- [x] Update canonical UX tracker and user-story docs with UX-127 / TEST-135.
- [x] Convert Timeline edit toolbar command buttons to icon-first fixed-width controls while preserving tooltips, accessibility labels, action wiring, and disabled states.
- [x] Update canonical UX tracker and user-story docs with UX-128 / TEST-136.
- [x] Group Timeline edit toolbar icon commands into visual command clusters so icon-first density still has recognizable mode, transition, selection edit, trim, edit-point, source, and session regions.
- [x] Update canonical UX tracker and user-story docs with UX-129 / TEST-137.
- [x] Add Timeline role color semantics so the overview, clip body, and role badge share one role color mapping with a visible used-role legend.
- [x] Update canonical UX tracker and user-story docs with UX-130 / TEST-138.
- [x] Add Timeline track and marker header semantics so V/A/O/C/M lanes show an icon, ID, and short Japanese kind label without shifting lane alignment.
- [x] Update canonical UX tracker and user-story docs with UX-131 / TEST-139.
- [x] Add Timeline ruler playhead HUD so the current timecode stays readable on the ruler after scrub gestures end.
- [x] Update canonical UX tracker and user-story docs with UX-132 / TEST-140.
- [x] Add Timeline overview scrub snap cue so whole-timeline scrub shows the same magnetic target feedback as ruler and empty-lane scrub.
- [x] Update canonical UX tracker and user-story docs with UX-133 / TEST-141.
- [x] Add Timeline overview visible viewport window so zoomed horizontal editing still shows which detail range is on screen.
- [x] Update canonical UX tracker and user-story docs with UX-134 / TEST-142.
- [x] Add Timeline active Viewer clip cue so overlapping clips show which visual/audio clip the Viewer is actually reading.
- [x] Update canonical UX tracker and user-story docs with UX-135 / TEST-143.
- [x] Add Viewer program source cue so the Viewer header shows the active visual/audio timeline clips under the playhead.
- [x] Update canonical UX tracker and user-story docs with UX-136 / TEST-144.
- [x] Add Viewer next program cue so the Program Viewer header shows the next non-current timeline clip before the cut.
- [x] Update canonical UX tracker and user-story docs with UX-137 / TEST-145.
- [x] Add Timeline loop range bands so selected-range loop playback is visible on the ruler and overview, not only in Transport.
- [x] Update canonical UX tracker and user-story docs with UX-138 / TEST-146.
- [x] Add Timeline follow-playhead playback mode so zoomed detail editing can keep the playhead in view during review playback.
- [x] Update canonical UX tracker and user-story docs with UX-139 / TEST-147.
- [x] Add Timeline skim preview so hover/navigate over clip bodies or empty lanes updates Viewer/timecode without moving the playhead.
- [x] Update canonical UX tracker and user-story docs with UX-140 / TEST-148.
- [x] Add Timeline clip thumbnail strips so video/overlay clips show visual content cues from the existing project thumbnail cache.
- [x] Update canonical UX tracker and user-story docs with UX-141 / TEST-149.
- [x] Add timeline-clip source reveal so editors can match a placed clip back to Source Monitor from context menu, Command Palette, or timeline-focus `F`.
- [x] Update canonical UX tracker and user-story docs with UX-142 / TEST-150.
- [x] Add source-bin auto-reveal for matched timeline clips so Source Monitor asset changes scroll the material shelf to the selected source row.
- [x] Update canonical UX tracker and user-story docs with UX-143 / TEST-151.
- [x] Add recommended transition drop target and drag-start Viewer preview so transition presets show the most likely edit point before exact hover.
- [x] Update canonical UX tracker and user-story docs with UX-144 / TEST-152.
- [x] Add lane-level transition preset magnetic drop so presets dropped on a video/overlay lane body snap to the nearest eligible edit point.
- [x] Update canonical UX tracker and user-story docs with UX-145 / TEST-153.
- [x] Add selected transition body duration drag so editors can adjust a selected transition from its body side regions, not only tiny edge grips.
- [x] Update canonical UX tracker and user-story docs with UX-146 / TEST-154.
- [x] Add explicit clip vertical drag lane lift so a single clip dropped onto an occupied compatible target lane resolves to an open/new lane instead of blocking.
- [x] Update canonical UX tracker and user-story docs with UX-147 / TEST-155.
- [x] Rename manual edit persistence copy so immediate timeline edits read as already visible and only waiting to be saved/preview-updated.
- [x] Update canonical UX tracker and user-story docs with UX-148 / TEST-156.
- [x] Add transition edit-point click wells so empty video/overlay seams can apply the default crossfade without starting from drag/drop or Command-T.
- [x] Update canonical UX tracker and user-story docs with UX-149 / TEST-157.
- [x] Add transition edit-point hover preview so empty video/overlay seams show the default crossfade in the Viewer before click/drop.
- [x] Update canonical UX tracker and user-story docs with UX-150 / TEST-158.
- [x] Add group nudge lane-lift so multiple selected clips move into an open/new compatible lane instead of pushing unselected overlapping clips back.
- [x] Update canonical UX tracker and user-story docs with UX-151 / TEST-159.
- [x] Add persistent Source Bin work bin so editors can manually collect review/replacement material after AI rough assembly.
- [x] Update canonical UX tracker and user-story docs with UX-152 / TEST-160.
- [x] Add a Source Bin thumbnail browsing mode so editors can scan source media visually while keeping preview, work-bin, favorite, quick-insert, and drag actions in reach.
- [x] Update canonical UX tracker and user-story docs with UX-153 / TEST-161.
- [x] Add Source Bin hover skim so row/tile thumbnails preview source content in the Viewer without selecting Source Monitor.
- [x] Update canonical UX tracker and user-story docs with UX-154 / TEST-162.
- [x] Localize transition preset labels consistently so palette chips, drag status, and drop cues show `黒へディップ` / `ソフトカット` instead of English shorthand.
- [x] Update canonical UX tracker and user-story docs with UX-155 / TEST-163.
- [x] Add active named Source Bin collections so editors can create a project-scoped selection bin by name and toggle row/tile assets into it.
- [x] Update canonical UX tracker and user-story docs with UX-156 / TEST-164.
- [x] Add timeline-scoped AI consultation prompt handoff so selected clips/transitions can seed a read-only Agent prompt without mutating timeline artifacts.
- [x] Update canonical UX tracker and user-story docs with UX-157 / TEST-165.
- [x] Add Source Bin multi-collection management so editors can switch, create, rename, and delete named selection bins without losing membership.
- [x] Update canonical UX tracker and user-story docs with UX-158 / TEST-166.
- [x] Add Source Bin visible-result bulk collection actions so filtered/searched source sets can be added to or removed from the active selection bin in one step.
- [x] Update canonical UX tracker and user-story docs with UX-162 / TEST-170.
- [x] Add Source Bin collection order management so editors can move the active named selection bin earlier/later and keep project-scoped order across create/rename/delete flows.
- [x] Verify Source Bin collection order helpers with Swift unit coverage, TypeScript typecheck, Studio build, and visible build-and-run launch.
- [x] Add one-click timeline Agent consultation so selected clips/transitions can prepare and run a read-only AI prompt when an Agent session is active.
- [x] Update canonical UX tracker and user-story docs with UX-163 / TEST-171.
- [x] Add read-only Agent result pinning to selected clip note drafts so AI consultation can be preserved for human editorial review without mutating timeline artifacts.
- [x] Update canonical UX tracker and user-story docs with UX-164 / TEST-172.
- [x] Add Clip Inspector annotation draft state so pinned AI consultation notes clearly show saved/unsaved/PREVIEW state and save only when the draft differs from the saved note.
- [x] Update canonical UX tracker and user-story docs with UX-165 / TEST-173.
- [x] Add Source Bin collection metadata/status so named selection bins can carry editorial purpose, review state, and notes across rename/delete flows.
- [x] Update canonical UX tracker and user-story docs with UX-166 / TEST-174.
- [x] Add structured Agent review-patch draft detection so read-only AI consultations can return previewable edit candidates without mutating timeline artifacts.
- [x] Update canonical UX tracker and user-story docs with UX-167 / TEST-175.
- [x] Add a guarded Agent review-patch apply plan so supported AI edit candidates can become visible unsaved Studio edits without partially applying unsafe operations.
- [x] Update canonical UX tracker and user-story docs with UX-168 / TEST-176.
- [x] Support structured Agent replace_segment candidates as visible unsaved Studio edits when select candidate data can safely resolve the replacement.
- [x] Update canonical UX tracker and user-story docs with UX-169 / TEST-177.
- [x] Allow existing transitions to be relocated by dropping onto a lane body, snapping to the nearest eligible edit point instead of requiring exact edit-point targeting.
- [x] Update canonical UX tracker and user-story docs with UX-170 / TEST-178.
- [x] Add a timeline-scoped Agent consultation intent for "make this beat shorter" so editors can ask for shorter rhythmic PREVIEW edits without leaving the manual timeline loop.
- [x] Update canonical UX tracker and user-story docs with UX-171 / TEST-179.
- [x] Add timeline keyboard clip selection navigation so Left/Right selects adjacent clips and Shift-Left/Shift-Right extends the selected range while syncing Viewer/playhead.
- [x] Update canonical UX tracker and user-story docs with UX-172 / TEST-180.
- [x] Add timeline edit-point keyboard navigation so Up/Down jumps the playhead and Viewer to adjacent clip boundaries, transitions, markers, or timeline boundaries without changing clip selection.
- [x] Update canonical UX tracker and user-story docs with UX-173 / TEST-181.
- [x] Add manual timeline navigation reveal so keyboard clip/edit-point jumps scroll zoomed detail views back to the playhead only when it would otherwise be lost.
- [x] Update canonical UX tracker and user-story docs with UX-174 / TEST-182.
- [x] Add drag target reveal so clip move and drag-trim previews scroll zoomed detail views toward the active target only when it would otherwise be lost.
- [x] Update canonical UX tracker and user-story docs with UX-175 / TEST-183.
- [x] Add roll edit drag target reveal so ROLL handle previews scroll zoomed detail views toward the moving edit boundary only when it would otherwise be lost.
- [x] Update canonical UX tracker and user-story docs with UX-176 / TEST-184.
- [x] Add transition duration drag target reveal so transition length previews scroll zoomed detail views toward the moving transition edge only when it would otherwise be lost.
- [x] Update canonical UX tracker and user-story docs with UX-177 / TEST-185.
- [x] Add transition duration Viewer resync so drag-previewed transition length changes update the Program Viewer overlay even when the overlay video URL stays the same.
- [x] Update canonical UX tracker and user-story docs with UX-178 / TEST-186.
- [x] Add lane-lift overlap avoidance badges so clips being avoided by magnetic lane lift are visible before drop.
- [x] Update canonical UX tracker and user-story docs with UX-179 / TEST-187.
- [x] Add group move target ghosts so grouped clips show their target-row shapes before drop when moving or lane-lifting together.
- [x] Update canonical UX tracker and user-story docs with UX-180 / TEST-188.
- [x] Add transition lane drop guides so preset/transition drags make compatible row-level magnetic drop lanes visible before hover.
- [x] Update canonical UX tracker and user-story docs with UX-181 / TEST-189.
- [x] Add clip lane drop guides so compatible V/A/O rows read as available vertical move targets during clip and group drags.
- [x] Update canonical UX tracker and user-story docs with UX-182 / TEST-190.
- [x] Add source candidate lane drop guides so compatible rows read as available source drop lanes while dragging material candidates into the timeline.
- [x] Update canonical UX tracker and user-story docs with UX-183 / TEST-191.
- [x] Add source timeline drag chips so Source Monitor and Source Bin candidates visibly advertise timeline drag/drop before the editor starts dragging.
- [x] Update canonical UX tracker and user-story docs with UX-184 / TEST-192.
- [x] Add transition preset drag affordance chips so preset buttons visibly show they can be dragged and reveal their default duration before the editor starts the drop.
- [x] Update canonical UX tracker and user-story docs with UX-185 / TEST-193.
- [x] Add transition drop cue duration labels so edit-point cues show the preset duration while the editor is dragging toward a cut.
- [x] Update canonical UX tracker and user-story docs with UX-186 / TEST-194.
- [x] Add existing transition move cue summaries so relocation feedback names the transition type and duration being moved.
- [x] Update canonical UX tracker and user-story docs with UX-187 / TEST-195.
- [x] Add clip move duration labels so single/group drag badges keep the moved clip or group span duration visible while relocating.
- [x] Update canonical UX tracker and user-story docs with UX-188 / TEST-196.
- [x] Add group move range duration labels so the wide group landing band shows the selected group span duration while dragging.
- [x] Update canonical UX tracker and user-story docs with UX-189 / TEST-197.
- [x] Add group target ghost duration labels so each moved clip ghost shows its own duration on the destination row.
- [x] Update canonical UX tracker and user-story docs with UX-190 / TEST-198.
- [x] Add single clip target ghost duration labels so lane-lift and direct track-move ghosts show clip duration on destination rows.
- [x] Update canonical UX tracker and user-story docs with UX-191 / TEST-199.
- [x] Add clip move landing cue duration labels so final drop rails show clip or group span duration beside target track and timecode.
- [x] Update canonical UX tracker and user-story docs with UX-192 / TEST-200.
- [x] Add blocked move cue duration labels so failed vertical target feedback keeps the attempted clip or group span duration visible.
- [x] Update canonical UX tracker and user-story docs with UX-193 / TEST-201.
- [x] Add blocked move cue legibility width so reason plus duration remains readable on short blocked targets.
- [x] Update canonical UX tracker and user-story docs with UX-194 / TEST-202.
- [x] Add clip lane drop guide duration labels so row-wide compatible target guides show moved clip/group span duration before hover.
- [x] Update canonical UX tracker and user-story docs with UX-195 / TEST-203.
- [x] Add clip lane drop guide target timecodes so row-wide compatible target guides name the landing time before hover.
- [x] Update canonical UX tracker and user-story docs with UX-196 / TEST-204.
- [x] Add clip lane drop guide snap labels so row-wide compatible target guides explain magnetic snap before hover.
- [x] Update canonical UX tracker and user-story docs with UX-197 / TEST-205.
- [x] Add transition preset lane guide duration labels so row-wide transition drop lanes show preset frame duration before hover.
- [x] Update canonical UX tracker and user-story docs with UX-198 / TEST-206.
- [x] Add transition lane guide edit-point range labels so row-wide transition drop lanes show eligible edit-point timecode range before hover.
- [x] Update canonical UX tracker and user-story docs with UX-199 / TEST-207.
- [x] Add transition candidate cue timecode labels so individual edit-point candidates show their boundary time while dragging.
- [x] Update canonical UX tracker and user-story docs with UX-200 / TEST-208.
- [x] Add transition magnet cue timecode details so hover/drop confirmation keeps the boundary time visible.
- [x] Update canonical UX tracker and user-story docs with UX-201 / TEST-209.
- [x] Add source candidate lane guide landing time and duration so row-wide source drop guides show where and how long before hover.
- [x] Update canonical UX tracker and user-story docs with UX-202 / TEST-210.
- [x] Add source candidate drop cue duration labels so final source drop confirmation shows material length beside landing timecode.
- [x] Update canonical UX tracker and user-story docs with UX-203 / TEST-211.
- [x] Add source candidate drop cue concrete snap labels so final source drop confirmation explains what magnetic target it snapped to.
- [x] Update canonical UX tracker and user-story docs with UX-204 / TEST-212.
- [x] Add source candidate drop ghost concrete snap labels so the large drag preview matches the final drop cue.
- [x] Update canonical UX tracker and user-story docs with UX-205 / TEST-213.
- [x] Add source candidate lane guide concrete snap labels so row-wide source drop feedback names the magnetic target before hover.
- [x] Update canonical UX tracker and user-story docs with UX-206 / TEST-214.
- [x] Add overview scrub concrete snap labels so whole-timeline playhead navigation names the magnetic target on the visible badge.
- [x] Update canonical UX tracker and user-story docs with UX-207 / TEST-215.
- [x] Add ruler scrub concrete snap labels so detailed playhead scrubbing names the magnetic target on the visible badge.
- [x] Update canonical UX tracker and user-story docs with UX-208 / TEST-216.
- [x] Add lane scrub concrete snap labels so playhead scrubbing directly on timeline lanes names the magnetic target on the visible badge.
- [x] Update canonical UX tracker and user-story docs with UX-209 / TEST-217.
- [x] Add transition magnet cue title timecodes so drop-before-release confirmation names the target edit point time on the most visible cue line.
- [x] Update canonical UX tracker and user-story docs with UX-210 / TEST-218.
- [x] Add transition lane guide primary target labels so the row-wide guide names the current nearest edit point before the magnet cue.
- [x] Update canonical UX tracker and user-story docs with UX-211 / TEST-219.
- [x] Add transition lane snap indicator rails so row-wide transition drags show the active nearest edit point as a vertical magnet rail.
- [x] Update canonical UX tracker and user-story docs with UX-212 / TEST-220.
- [x] Add a visible Source Monitor append button so timeline-end insertion is discoverable without learning the E shortcut first.
- [x] Update canonical UX tracker and user-story docs with UX-213 / TEST-221.
- [x] Add an adaptive Source Monitor action row so insert/append/overwrite/replace/return controls wrap instead of clipping in narrow panels.
- [x] Update canonical UX tracker and user-story docs with UX-214 / TEST-222.
- [x] Add visible W/E/D/R shortcut hints to Source Monitor edit buttons so FCPX-like source operations are discoverable in the panel.
- [x] Update canonical UX tracker and user-story docs with UX-215 / TEST-223.
- [x] Add adaptive Source Monitor marked-range controls so IN/OUT mark, nudge, and reset buttons wrap instead of clipping in narrow panels.
- [x] Update canonical UX tracker and user-story docs with UX-216 / TEST-224.
- [x] Add focus-gated Source Monitor candidate navigation shortcuts and visible [ / ] hints so editors can cycle select candidates without mouse travel.
- [x] Update canonical UX tracker and user-story docs with UX-217 / TEST-225.
- [x] Add Source Monitor candidate navigation Command Palette commands so previous/next source candidates are discoverable without memorizing [ / ].
- [x] Update canonical UX tracker and user-story docs with UX-218 / TEST-226.
- [x] Add Source Monitor marked-range Command Palette commands so IN/OUT nudge and reset are discoverable beyond small panel buttons.
- [x] Update canonical UX tracker and user-story docs with UX-219 / TEST-227.
- [x] Add focus-gated Source Monitor marked-range shortcuts and visible shortcut hints so IN/OUT nudge/reset can stay in the keyboard loop.
- [x] Update canonical UX tracker and user-story docs with UX-220 / TEST-228.
- [x] Add focus-gated Source Monitor J/K/L/Space transport shortcuts so source review can stay in the keyboard loop.
- [x] Update canonical UX tracker and user-story docs with UX-221 / TEST-229.
- [x] Add Source Monitor comma/period source-time frame step so source review can advance precisely without leaving the source loop.
- [x] Update canonical UX tracker and user-story docs with UX-222 / TEST-230.
- [x] Add Command Palette direct actions for timeline-scoped Agent consultation intents so editors can ask AI to tighten, shorten, find alternates, or explain a cut from the timeline context.
- [x] Update canonical UX tracker and user-story docs with UX-223 / TEST-231.
- [x] Add clip-body drag-begin selection so grabbing an unselected clip immediately makes it the primary timeline context without moving the playhead.
- [x] Update canonical UX tracker and user-story docs with UX-224 / TEST-232.
- [x] Add transition-duration drag-begin selection so grabbing an existing transition's duration region immediately switches into transition context.
- [x] Update canonical UX tracker and user-story docs with UX-225 / TEST-233.
- [x] Add transition move-handle drag-begin selection so grabbing an existing transition's center move handle immediately switches into transition context.
- [x] Update canonical UX tracker and user-story docs with UX-226 / TEST-234.
- [x] Add Timeline Agent consultation preview summary so editors can see selected clip/transition context and the read-only PREVIEW contract before generating or running a prompt.
- [x] Update canonical UX tracker and user-story docs with UX-227 / TEST-235.
- [x] Add Command Palette prompt-only Timeline Agent preparation so editors can inspect the generated consultation prompt before any Agent turn runs.
- [x] Update canonical UX tracker and user-story docs with UX-228 / TEST-236.
- [x] Add Agent review_patch impact labels so AI edit proposals show concrete operation effects before Timeline display apply.
- [x] Update canonical UX tracker and user-story docs with UX-229 / TEST-237.
- [x] Prefer the recommended transition edit point in lane guides before hover resolves a nearer target.
- [x] Update canonical UX tracker and user-story docs with UX-230 / TEST-238.
- [x] Show selected/hovered applied transition duration on the timeline body before duration drag begins.
- [x] Update canonical UX tracker and user-story docs with UX-231 / TEST-239.
- [x] Show selected/hovered clip timing metadata on the clip body before drag or trim begins.
- [x] Update canonical UX tracker and user-story docs with UX-232 / TEST-240.
- [x] Add transition preset active drag status with preset, duration, and edit-point destination cue.
- [x] Update canonical UX tracker and user-story docs with UX-233 / TEST-241.
- [x] Add transition preset body cues on eligible edit-point wells before hover resolves a drop target.
- [x] Update canonical UX tracker and user-story docs with UX-234 / TEST-242.
- [x] Add source candidate drop ghost marked-range labels so Timeline drag previews show the exact marked source span when wide enough.
- [x] Update canonical UX tracker and user-story docs with UX-235 / TEST-243.
- [x] Add source drag chip source-range labels so editors can confirm the carried IN/OUT span before dragging to Timeline.
- [x] Update canonical UX tracker and user-story docs with UX-236 / TEST-244.
- [x] Add source range to the active Timeline source drop cue so the carried IN/OUT span stays visible while hovering over lanes.
- [x] Update canonical UX tracker and user-story docs with UX-237 / TEST-245.
- [x] Add move delta/snap/lane-lift detail to clip move landing cues so the drop result is readable at the target line.
- [x] Update canonical UX tracker and user-story docs with UX-238 / TEST-246.
- [x] Add target timecode labels to clip move target ghosts so cross-track and lane-lift drop positions are readable on the ghost itself.
- [x] Update canonical UX tracker and user-story docs with UX-239 / TEST-247.
- [x] Add transition duration drag Viewer preview frames so the Program Viewer follows the changing transition interior before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-240 / TEST-248.
- [x] Add created-lane lift cue so automatic new-track overlap avoidance is readable during clip/group drag.
- [x] Update canonical UX tracker and user-story docs with UX-241 / TEST-249.
- [x] Add drag-trim Viewer preview so selected clip IN/OUT edge drags update Program Viewer before mouse-up.
- [x] Update canonical UX tracker and user-story docs with UX-159 / TEST-167.
- [x] Add direct selected-clip slip drag handle so source range can be shifted from the timeline surface with live Viewer preview.
- [x] Update canonical UX tracker and user-story docs with UX-160 / TEST-168.
- [x] Add direct selected edit-point roll drag handles so incoming/outgoing roll trim can be adjusted from the timeline surface with live Viewer preview.
- [x] Update canonical UX tracker and user-story docs with UX-161 / TEST-169.
- [x] Add source monitor marked insert range controls so source candidates can be trimmed before insert-at-playhead or candidate-card drag/drop.
- [x] Update canonical UX tracker and user-story docs with UX-77 / TEST-85.
- [x] Add draggable source range handles so marked source IN/OUT can be adjusted from a visible range bar, not only via nudge buttons.
- [x] Update canonical UX tracker and user-story docs with UX-78 / TEST-86.
- [x] Add source monitor marked replace so source IN/OUT handles also affect selected-clip replacement, not only insert/drop.
- [x] Update canonical UX tracker and user-story docs with UX-79 / TEST-87.
- [x] Add source monitor marked overwrite at playhead using `insert_segment` plus edge trim/remove operations without adding a new schema op.
- [x] Update canonical UX tracker and user-story docs with UX-80 / TEST-88.
- [x] Add middle-spanning source monitor overwrite by inserting first, splitting at overwrite out, trimming the original left remainder, and keeping outgoing transitions on the generated right remainder.
- [x] Update canonical UX tracker and user-story docs with UX-81 / TEST-89.
- [x] Add source monitor overwrite pre-click timeline preview so the target range and delete/trim/split impacts are visible before pressing overwrite.
- [x] Update canonical UX tracker and user-story docs with UX-82 / TEST-90.
- [ ] Run the consolidated human confirmation queue in `docs/project-memory/CONTINUITY.md` once the next interaction batch is ready, instead of interrupting each slice for manual checks.
- [ ] Continue the next M6.5 operation-feel slice after human motion feedback: deeper source workflow polish or next AI edit-loop preview/apply handoff depending on the observed friction.

### Candidate: M7 — AI-Assisted Edit Bench

Goal: let the editor ask AI for local alternatives while staying in timeline context.

- [x] Add timeline-scoped AI actions such as "tighten this section", "find stronger alternate", "make this beat shorter", and "explain why this cut works".
- [x] Keep every AI action previewable as patch diffs before mutation.
- [x] Feed clip evidence, QA issues, transcript/Marlin/audio signals, and current timeline context into the prompt.

### Candidate: M8 — Media Browser and Source Monitor

Goal: make footage browsing feel like a real editorial bin/source workflow.

- [ ] Continue toward a persistent media browser with bins; source-bin compact filter menu, filter/sort/search, source monitor context, folder/status/kind/usage smart-bin grouping, favorites, a persistent manual work bin, active named selection collections with create/rename/delete management and project-scoped order controls, used/unused filters, timeline clip thumbnails, Source Bin thumbnail browsing, and Source Bin hover skim now persist or derive from project/timeline state, while nested folders and direct drag-reorder remain future work.
- [x] Support the first marked source in/out range before adding timeline clips by insert-at-playhead or source-card drag/drop.
- [x] Add draggable source range handles for marked insert/drop source selection.
- [x] Mark source IN/OUT from the current source monitor playback position.
- [x] Gate source monitor `I` / `O` keyboard marks behind source-monitor focus.
- [x] Add marked source in/out before replacing selected timeline clips.
- [x] Extend source monitor actions beyond marked insert/replace into the first edge-safe marked overwrite patch operations.
- [x] Support middle-spanning overwrite by splitting existing clips into left/right remainders with stable generated IDs.
- [x] Preview source overwrite target ranges and delete/trim/split impacts on the timeline before the editor commits the overwrite.
- [x] Show source candidate card drag ghost duration and incompatible-lane feedback before the editor drops into the timeline.
- [x] Lift source candidate card drops away from occupied compatible lanes into an open/new lane before mouse-up and on commit.
- [x] Snap source candidate card drops to nearby edit points, playhead, markers, or timeline start with visible cue/rail feedback before mouse-up.
- [x] Clarify transition preset lane drops with explicit "release on lane to magnet-apply" labels, drop snap badge copy, and magnet cue detail.
- [x] Update canonical UX tracker and user-story docs with UX-242 / TEST-250.
- [x] Show transition drag blocked-lane guides on non-visual tracks so unsupported audio/caption/marker lanes do not look silently broken.
- [x] Update canonical UX tracker and user-story docs with UX-243 / TEST-251.
- [x] Cycle Source Monitor select candidates with focus-gated [ / ] shortcuts and visible candidate header hints.
- [x] Expose Source Monitor select candidate previous/next actions through Command Palette search and disabled-state copy.
- [x] Expose Source Monitor marked-range IN/OUT nudge and reset actions through Command Palette search and disabled-state copy.
- [x] Nudge Source Monitor marked IN/OUT and reset the range with focus-gated shortcuts plus visible panel/Palette hints.
- [x] Review Source Monitor source candidates with focus-gated J/K/L/Space transport shortcuts.
- [x] Step Source Monitor source time by one frame with focus-gated comma/period shortcuts and immediate Viewer seek.

### Candidate: M9 — Visual Finish and Performance Pass

Goal: make Studio feel dense, stable, and professional at real project scale.

- [ ] Improve remaining advanced timeline navigation semantics; baseline timeline density, overview, overview viewport window, overview snap cue, role color, track/marker header, and ruler playhead HUD semantics now have first M6.5 controls.
- [ ] Continue reducing form-heavy surfaces where editors need fast repeated action; first timeline viewport preferences now persist.
- [ ] Verify with screenshots and interaction smoke tests across compact and wide layouts.

## Out of Scope

- Broad rewrites of schemas, compiler contracts, or planning routes without explicit approval.
- Making optional model caches, external APIs, source footage, or generated media required for baseline validation.
- Treating `.codex/` restructuring as part of routine memory updates.

## Risks and Unknowns

- The repo often has a dirty worktree; agents must preserve unrelated changes.
- Some local model smoke tests depend on cache and Python venv state outside the repo.
- Full verification can be slower and may expose environment blockers distinct from product regressions.
- SwiftPM tests previously hit a local macOS code-signing policy blocker, but `swift test --package-path apps/macos-studio` passed 305 tests / 0 failures on 2026-06-25 after the timeline zoom/fit slice.
- The next milestone should avoid broad schema churn; prefer using existing review/studio patch contracts unless a direct-edit operation cannot be represented safely.
# 2026-07-13 Longform Event Editing

- [x] Add the `longform-event` profile and `longform-documentary` policy without changing the short `event-recap` contract.
- [x] Build deterministic transcript-window reduction with primary-lane selection, chapter coverage, exact trims, exclusion reasons, and a hard duration gate.
- [x] Connect the mode to both the canonical `npm run full-pipeline` route and the command-based triage/blueprint route.
- [x] Compile a 136-clip, 62.7-minute plan from 168.2 minutes of Lively ALT sources through the existing compiler without writing project artifacts.
- [ ] Render and inspect a real one-hour rough cut, including A/V sync and output-size/runtime behavior.
- [ ] Add chapter-sampled visual/audio QA and bounded automatic repairs for visual-only dead time, multicamera switches, applause, and music-only intervals.
