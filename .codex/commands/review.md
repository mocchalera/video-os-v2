# /review

Gate 7-8 only. Review an already compiled timeline and emit review artifacts.

## Runtime
- `runtime/commands/review.ts`
- Call `runReview(project, reviewAgent, { requireCompiledTimeline: true, ...options })`

## Gate Check
- `timeline_gate` must be `open`
- `compile_gate` must be `open`
- `planning_gate` must be `open`

## Contract
1. Reconcile `project_state.yaml`.
2. Do not auto-compile in phase-split mode.
3. Read existing `05_timeline/timeline.json`, generate `06_review/review_report.yaml` and `06_review/review_patch.json`.
4. Update `progress.json` on success and failure.
