# Pipeline Plan Unification

Date: 2026-07-09

## Scope

- Added `runtime/pipeline/plan.ts` as the shared source for canonical pipeline stages, runtime full-pipeline phases, and progress timing-stage plans.
- Rewired `scripts/full-pipeline.ts`, `runtime/commands/full-pipeline.ts`, and `scripts/editorial-pipeline.ts` to use the shared plan builders.
- Added focused regression coverage in `tests/pipeline-plan.test.ts`.

## Verification

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run tests/pipeline-plan.test.ts tests/phase-commands.test.ts
-> 2 test files passed, 14 tests passed

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run typecheck
-> passed

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run validate
-> valid true, artifacts_checked 15, error_count 0, warning_count 0

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run verify:repo
-> Repo hygiene passed for 1351 tracked file(s)

git diff --check
-> passed
```
