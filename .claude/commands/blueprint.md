# /blueprint

Gate 5 only. Build `04_plan/edit_blueprint.yaml` and `04_plan/uncertainty_register.yaml`.

## Runtime
- `runtime/commands/blueprint.ts`
- Call `runBlueprint(project, blueprintAgent, options)`

## Gate Check
- `04_plan/selects_candidates.yaml` must exist
- `01_intent/creative_brief.yaml` and `01_intent/unresolved_blockers.yaml` must exist

## Contract
1. Reconcile `project_state.yaml`.
2. Refuse to continue when selects or intent artifacts are missing.
3. Promote only blueprint artifacts.
4. If uncertainty blockers remain, leave the project in `blocked`.
5. Update `progress.json` on success and failure.
