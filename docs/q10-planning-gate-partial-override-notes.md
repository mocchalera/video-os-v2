# Q10 Planning Gate partial_override Notes

## Scope

Q10 adds `partial_override` to `project_state.yaml` `gates.planning_gate` as an additive schema value.

This value means some planning uncertainty has been operator-reviewed, resolved, or waived enough to continue, while remaining uncertainty is still worth surfacing as warning-level context. It is distinct from:

- `open`: no known planning uncertainty blocks or warnings are active.
- `blocked`: unresolved planning uncertainty must stop runtime progress.
- `partial_override`: runtime progress is allowed, but downstream operators should see that planning was not fully clean.

## Impact Scan

`planning_gate` references found before implementation:

- `schemas/project-state.schema.json`: schema enum previously allowed only `open` and `blocked`.
- `runtime/state/reconcile.ts`: `GateStatus["planning_gate"]` and `computeGates()` currently compute only `open` or `blocked` from `04_plan/uncertainty_register.yaml`.
- `runtime/commands/compile.ts`: blocks only when `planning_gate === "blocked"`.
- `runtime/commands/review/index.ts`: blocks only when `planning_gate === "blocked"`.
- `runtime/commands/status.ts`: recommends uncertainty resolution only for blocked planning gate.
- tests with direct expectations or fixtures: `tests/state.test.ts`, `tests/commands.test.ts`, `tests/package-assembler.test.ts`, `tests/e2e-m4.test.ts`, `tests/release-safety-report.test.ts`, `tests/caption-narrative-improvement.test.ts`.

## Runtime Interpretation

Runtime interpretation is intentionally non-breaking:

- `open`: severity `ok`, does not block runtime.
- `partial_override`: severity `warning`, does not block runtime.
- `blocked`: severity `blocker`, blocks runtime.
- unknown future values: severity `warning`, do not block runtime by default in `/status` interpretation.

`runtime/state/reconcile.ts` remains unchanged for Q10 because it was outside the task allowlist. Reconcile still computes `open` or `blocked`; `partial_override` is accepted as a persisted/project-state schema value and interpreted by `/status`.

## Test Coverage

Added:

- `tests/fixtures/project_state/partial-override-valid.json`: schema-valid project state with `gates.planning_gate = "partial_override"`.
- `tests/fixtures/project_state/partial-override-transition.json`: fixture documenting `blocked` to `partial_override` severity transition.
- `tests/project-state-partial-override.test.ts`: validates the schema fixture and locks runtime interpretation for blocked versus partial override.

Initial red:

- schema rejected `partial_override` because `planning_gate` enum only allowed `open` and `blocked`;
- `interpretPlanningGate` did not exist yet.

Green:

- `npx vitest run tests/project-state-partial-override.test.ts` passed: 1 file, 2 tests.

## Canonical Hash

Q10 does not touch timeline schemas, compiler paths, render paths, packaging paths, or demo timeline artifacts. The canonical hash check uses `projects/demo/05_timeline/timeline.json` with `created_at` excluded, matching prior P3/P4 notes.
