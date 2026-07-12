# /render

Gate 9-10 only. Run packaging and final render checks.

## Runtime
- `runtime/commands/render.ts`
- Call `runRender(project, options)`
- CLI entry point: `npm run package -- <project> [options]`
- Direct entry point: `npx tsx scripts/package.ts <project> [options]`

## Gate Check
- Project must already be `approved` or a rerunnable `packaged`
- Packaging prerequisites must pass inside `packageCommand`

## Contract
1. Reconcile `project_state.yaml`.
2. Show human-readable Gate 10 prerequisite gaps before packaging.
3. For `engine_render`, generate stale/missing `05_timeline/assembly.mp4` unless `--no-assembly` or explicit `--assembly-path` is used.
4. Run packaging / render only.
5. Emit `07_package/*` and `09_output/final.mp4`.
6. Transition to `packaged` only after QA passes.
7. Update `progress.json` on success and failure.
