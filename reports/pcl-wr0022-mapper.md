# Agent review_patch preview diff surface mapped

## Findings

- The M7 plan still had one unchecked requirement: keep every AI action previewable as patch diffs before mutation.
- Timeline-scoped Agent consultations already ask for optional `review_patch` JSON, and `TimelineAgentReviewPatchDraft` extracts structured operations from read-only Agent turns.
- `TimelineAgentReviewPatchApplyPlan.evaluate(...)` already computes the updated timeline for supported operations before any Studio state mutation, which made it the right place to generate deterministic before/after preview summaries.
- The Agent panel showed operation names, targets, and impact labels before the `Timelineへ表示反映` button, but did not show a before/after diff derived from the current timeline.

## Evidence

- `docs/project-memory/PLANS.md` M7 listed "Keep every AI action previewable as patch diffs before mutation" as unchecked before this slice.
- `apps/macos-studio/Sources/VideoOSStudioCore/TimelineAgentReviewPatchDraft.swift` extracts `review_patch` blocks and builds operation summaries.
- `apps/macos-studio/Sources/VideoOSStudioCore/TimelineAgentReviewPatchApplyPlan.swift` evaluates supported operations and produces an in-memory updated timeline before applying to Studio state.
- `apps/macos-studio/Sources/VideoOSStudio/AgentInspectorViews.swift` renders the draft summary and `Timelineへ表示反映` button.
- `apps/macos-studio/Tests/VideoOSStudioCoreTests/TimelineAgentReviewPatchApplyPlanTests.swift` covers preview apply planning and now covers before/after diff summaries.

## Recommended pcl Commands

- `pcl feature add --name "Agent review_patch before-after preview diffs" --surface "apps/macos-studio" --description "Show deterministic before/after diff summaries for supported AI review_patch operations before the editor reflects them into the Timeline, preserving the read-only Agent contract and leaving review_patch schema, compiler contracts, timeline artifacts, source media, and rendered outputs unchanged." --evidence "reports/pcl-wr0022-mapper.md; docs/project-memory/PLANS.md M7 AI-Assisted Edit Bench; TimelineAgentReviewPatchApplyPlan.swift; AgentInspectorViews.swift; TimelineAgentReviewPatchApplyPlanTests.swift"`
