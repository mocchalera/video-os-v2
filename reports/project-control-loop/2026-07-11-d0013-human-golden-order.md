# D-0013 — human golden order contract repair

Date: 2026-07-11 JST
Goal / feature: G-0002 / F-0035
Workflow: WR-0041

## Defect

The Togakushi 24 fps Golden compile declared `human_golden_order`, but the
skill was absent from the registry. `candidate_plan` fallback refs were treated
as an unordered scoring set, while the assembler globally deduplicated source
ranges. The intended three-shot closing bookend was therefore removed after
the same sources were used in the opening.

Observed before repair:

- expected: 29 authored placements / 2825 frames
- actual: 26 placements / 2540 frames
- deficit: 285 frames (10.09%), isolated to b06 (170 / 455 frames)
- candidate-plan order was not preserved
- continuity metadata reported 0 reorders, 0 warnings, and 0 errors

## Repair

- Registered `human_golden_order` as an active assemble-phase editorial skill.
- Added an opt-in exact candidate-plan assembly path. It consumes primary then
  fallbacks in authored order, excludes unplanned candidates, and permits
  explicit cross-beat source reprises.
- Disabled cluster and cached-visual reordering while the exact-order contract
  is active.
- Added a pre-export structural gate that blocks missing/reordered authored
  placements and duration drift above the blueprint rubric tolerance.
- Derived narrow `allow_revisit` continuity exemptions only for candidate refs
  explicitly repeated by the authored plan.
- Made generated original-audio mirrors occurrence-aware so repeated bookend
  video placements each retain their own A1 mirror.
- Added focused assembly, skill activation, continuity, and non-golden
  compatibility regressions.

## Verification

Scratch project:

`tmp/D-0013-togakushi-24p-NTqHXr`

24 fps compile result:

- 29 expected placements / 29 actual placements
- expected and actual segment-order SHA-256:
  `5bdd67013cd64dcc630ce2b31d8759136ce64fbdef6eba5071733f561fd4c7e6`
- 2825 / 2825 frames; delta 0; duration status `pass`
- all six beats have fill ratio 1.0
- 29 A1 generated audio mirrors
- continuity: 0 reorders, 0 warnings, 0 errors
- timeline SHA-256:
  `08d0de41d0b244daca982175e8a7f56526ca2bc416ae778b6fd5c666c888684a`
- schema validation passed

Commands:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run tests/v1-first-layout.test.ts tests/m45-skills.test.ts tests/compiler-continuity.test.ts
# 44 passed

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsc --noEmit

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx tsx scripts/compile-timeline.ts tmp/D-0013-togakushi-24p-NTqHXr --fps 24 --skip-preview

PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run verify
# retry after one Vitest worker RPC timeout: all gates passed
# 161 test files passed, 4 skipped
# 2644 tests passed, 39 skipped
```

The first aggregate verification run completed all 2642 tests without a test
assertion failure but exited on a Vitest worker `onTaskUpdate` RPC timeout. One
clean retry passed all typecheck, unit-test, schema, and review-metric gates.
After adding permanent missing-placement and duration-tolerance gate tests, the
final aggregate run passed 2644 tests with all gates green.

## Artifact boundary

The scratch timeline and generated project/media outputs remain under `tmp/`
and are intentionally uncommitted. Canonical Togakushi artifacts were not
overwritten.
