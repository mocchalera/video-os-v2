# /triage

Gate 4 only. Consume analysis artifacts and emit `04_plan/selects_candidates.yaml`.

## Runtime
- `runtime/commands/triage.ts`
- Call `runTriage(project, triageAgent, options)`

## Gate Check
- `analysis_gate` must be `ready` or `partial_override`
- `01_intent/creative_brief.yaml` must exist

## Contract
1. Reconcile `project_state.yaml`.
2. Refuse to continue if prerequisites are not satisfied.
3. Promote only `04_plan/selects_candidates.yaml`.
4. On success, update `project_state.yaml` and `progress.json`.
