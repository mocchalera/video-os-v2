# /render

Gate 9-10 only. Run packaging and final render checks.

## Runtime
- `runtime/commands/render.ts`
- Call `runRender(project, options)`

## Gate Check
- Project must already be `approved` or a rerunnable `packaged`
- Packaging prerequisites must pass inside `packageCommand`

## Contract
1. Reconcile `project_state.yaml`.
2. Run packaging / render only.
3. Emit `07_package/*`.
4. Transition to `packaged` only after QA passes.
5. Update `progress.json` on success and failure.
