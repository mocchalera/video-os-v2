# /compile

Gate 6 only. Compile `05_timeline/timeline.json` from canonical planning artifacts.

## Runtime
- `runtime/commands/compile.ts`
- Call `runCompilePhase(project, options)`

## Gate Check
- `compile_gate` must be `open`
- `planning_gate` must be `open`
- `04_plan/edit_blueprint.yaml` must exist

## Notes
- Orchestrator use may pass a review patch into compile phase.
- Standalone phase usage should compile without patch input.

## Contract
1. Reconcile `project_state.yaml`.
2. Refuse to continue when compile or planning gates are blocked.
3. Validate generated `timeline.json`.
4. Update `project_state.yaml` and `progress.json`.
