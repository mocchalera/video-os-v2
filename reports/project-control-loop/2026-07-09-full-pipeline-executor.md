# Full Pipeline Executor Extraction

Date: 2026-07-09

## Scope

- Added `runtime/pipeline/executor.ts` as the runtime-owned executor for the single-command full pipeline.
- Kept `scripts/full-pipeline.ts` as a CLI adapter: argument parsing plus dependency wiring for `initProject` and `runEditorialPipeline`.
- Added `tests/pipeline-executor.test.ts` to cover dependency order, skip semantics, failure formatting, and deterministic source-file resolution.

## Verification

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run tests/pipeline-executor.test.ts tests/pipeline-plan.test.ts tests/phase-commands.test.ts
-> 3 test files passed, 18 tests passed

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run typecheck
-> passed

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run validate
-> valid true, artifacts_checked 15, error_count 0, warning_count 0

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run verify:repo
-> Repo hygiene passed for 1354 tracked file(s)

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run build
-> passed

git diff --check
-> passed
```
