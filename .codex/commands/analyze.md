# /analyze

Gate 1 only. Run material analysis without advancing triage or later phases.

## Inputs
- `project`: project directory
- `sources[]`: one or more source media files

## Runtime
- `runtime/commands/analyze.ts`
- Call `runAnalyze(project, options)`

## Contract
1. Reconcile `project_state.yaml` before running.
2. Require at least one source file.
3. Run analysis only.
4. On success, update `project_state.yaml` via reconcile and write `progress.json`.
5. On failure, write the error into `progress.json` and stop.
