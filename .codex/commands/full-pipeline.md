# /full-pipeline

Orchestrate the phase commands in order while preserving the existing end-to-end behavior.

## Runtime
- `runtime/commands/full-pipeline.ts`
- Call `runFullPipeline(project, deps, options)`

## Sequence
- `/analyze`
- `/intent` when brief / blockers are missing
- `/triage`
- `/blueprint`
- `/compile`
- `/review`
- `/render` when target is `package`

## Resume
- Support `--from <phase>`
- Valid phase values: `analyze`, `triage`, `blueprint`, `compile`, `review`, `render`
- Without `--from`, detect the earliest incomplete phase from artifacts and `project_state.yaml`

## Compatibility
- Existing review approval behavior stays intact
- Safe review patches may trigger `compile -> review` once more inside the orchestrator
