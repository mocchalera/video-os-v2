# Agent review_patch preview diff tests designed

## Findings

- Unit coverage belongs in `TimelineAgentReviewPatchApplyPlanTests` because the before/after diff rows must be deterministic and derived from the current `TimelineDocument`.
- The supported path covers trim, split, transition, move, remove, and replace where candidate data is available.
- The blocked path preserves existing no-partial-apply behavior: if a patch is blocked, no applyable diff rows imply that Studio can reflect it.
- A build/app launch check remains useful because the rows are user-facing in `AgentInspectorViews`.

## Evidence

- `TimelineAgentReviewPatchApplyPlanTests` creates fixture timelines, candidate data sources, and supported/blocked Agent review_patch operations.
- `AgentInspectorViews.swift` is the display surface for review_patch draft rows and the `Timelineへ表示反映` button.
- `StudioViewModel.applySelectedAgentReviewPatchDraftToTimeline()` remains the mutation point; preview diff rows are computed before that call.

## Recommended pcl Commands

- `pcl test plan --feature F-0021 --story US-0005 --type unit --scenario "Evaluate a supported Agent review_patch containing trim, split, transition, move, remove, and replace operations against a fixture timeline." --expected "The apply plan is applyable and exposes concise before/after preview diff rows that match the current timeline and candidate data before any Studio state mutation."`
- `pcl test plan --feature F-0021 --story US-0005 --type unit --scenario "Evaluate a blocked Agent review_patch containing an unsupported or unresolved operation." --expected "The apply plan remains non-applyable, returns the existing blocked reason, keeps the original timeline, and does not expose misleading before/after rows as applyable evidence."`
- `pcl test plan --feature F-0021 --story US-0005 --type manual --scenario "In the running macOS app, select a read-only Agent turn with a supported review_patch and inspect the Agent panel before pressing Timeline display apply." --expected "The Agent panel shows readable before/after diff rows above the apply button, the patch remains marked PREVIEW/保存前, and timeline/manual edit state does not change until the editor explicitly presses Timelineへ表示反映."`
