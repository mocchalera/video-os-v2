# Editorial Entrypoint Runtime Calls

Date: 2026-07-09

## Scope

- Made `scripts/compile-timeline.ts` import-safe by exporting `runCompileTimeline`, `parseArgs`, and `main`, and by replacing direct `process.exit(1)` paths with errors returned through `main`.
- Exported `renderRoughCut` from `scripts/render-rough-cut.ts`.
- Replaced compile/render CLI subprocess calls in `scripts/editorial-pipeline.ts` and `scripts/editorial-agent-task.ts` with direct function calls.
- Added `tests/editorial-entrypoints.test.ts` to prevent editorial orchestration from reintroducing `npx tsx scripts/compile-timeline.ts` or `npx tsx scripts/render-rough-cut.ts` shell-outs.
- Fixed single-layout compiler audio handling so authored dialogue can occupy A1 when V1 is visual, while preserving the existing V1-first rule that selected V1 dialogue is mirrored as original audio instead of placing rejected dialogue on A1.

## Verification

```text
npx vitest run tests/editorial-entrypoints.test.ts tests/unified-editorial-agent.test.ts
-> 2 test files passed, 22 tests passed

npx vitest run tests/audio-policy.test.ts tests/v1-first-layout.test.ts
-> 2 test files passed, 25 tests passed

npm run verify
-> typecheck passed
-> unit-tests passed: 151 files passed, 2571 tests passed, 39 skipped
-> schema-validation (demo) passed: artifacts_checked 15, error_count 0, warning_count 0
-> review-metrics (demo) passed
-> All gates passed

npm run build
-> passed

npm run verify:repo
-> Repo hygiene passed for 1358 tracked file(s)

git diff --check
-> passed
```
