# Agent review_patch preview diff story drafted

## Findings

- The story focuses on the editor's last safety check before an AI suggestion becomes a visible unsaved Studio edit.
- Expected behavior distinguishes three states: the AI has only suggested a patch, Studio can compute a before/after preview diff, and the editor has explicitly chosen to reflect that patch into the Timeline view.
- The mutation boundary stays unchanged: showing diff summaries does not write files, alter `timeline.json`, apply compiler patches, or start an Agent write job.

## Evidence

- `TimelineAgentReviewPatchDraft.extract(...)` only works on read-only Agent turn text and does not mutate Studio state.
- `TimelineAgentReviewPatchApplyPlan.evaluate(...)` builds an in-memory `updatedTimeline` and now compares current timeline state to planned changes before `StudioViewModel.applySelectedAgentReviewPatchDraftToTimeline()` mutates view state.
- `AgentInspectorViews.swift` shows draft operation rows, before/after diff rows, and the explicit `Timelineへ表示反映` button.
- `docs/project-memory/PLANS.md` M7 calls for AI actions to stay previewable as patch diffs before mutation.

## Recommended pcl Commands

- `pcl story draft --feature F-0021 --actor "macOS Studio editor" --goal "review AI review_patch suggestions as concrete before/after diffs before reflecting them into the Timeline" --benefit "so AI trim, move, split, remove, replace, and transition suggestions can be checked against the current timeline state before any visible unsaved edit is created" --expected-behavior "When a read-only Agent turn contains a supported review_patch, the Agent panel shows concise before/after diff rows derived from the current timeline before the Timeline display apply button. The rows cover supported operations such as trim, move, split, remove, replace, and transition updates when those operations can be evaluated. If the patch is blocked, the panel keeps the blocked reason and does not show a misleading applyable diff. No files, timeline artifacts, schema, compiler outputs, source media, rendered media, or Agent write scopes are changed by previewing these rows."`
