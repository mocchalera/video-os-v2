# Phase 4+5 Implementation Review

Review date: 2026-06-22

Overall verdict: **Fail**

Reason: the Phase 4/5 behavior is mostly aligned with the design, and the Swift target/tests pass, but `npm run build` currently fails on the newly added QA report test. This keeps the branch from being typecheck-clean.

## Findings

### Fail: TypeScript build is red in the new QA report test

- Evidence: `npm run build` fails with `TS2352` at `tests/qa-improvement-report.test.ts:87`.
- Cause: `Object.fromEntries(...) as StageResult["axes"]` is rejected under the repo's strict `tsconfig.json`, which includes `tests/**/*.ts`.
- Impact: runtime tests pass, but the standard TypeScript build fails.
- Relevant code: `tests/qa-improvement-report.test.ts:85-107`, `tsconfig.json:15-19`.

### Concern: Insert-only Studio patches do not jump or highlight

- Existing target-clip operations are handled: `applyStudioPatch()` captures `changedClipIDs`, refreshes, highlights, then jumps to the first changed clip.
- Insert operations are not represented because `ReviewPatchOperation.changedClipID` returns only `targetClipID`, and `insert_segment` has no target clip. `StudioFeedbackSession.changedClipIDs` also filters to compiler-valid ops but still only compactMaps `changedClipID`.
- Impact: a patch containing only an inserted segment can update the timeline without the requested first-change jump or blue highlight.
- Relevant code: `StudioViewModel.swift:1696-1699`, `StudioViewModel.swift:1754-1759`, `StudioViewModel.swift:1875-1901`, `ReviewPatchDocument.swift:168-184`, `StudioFeedbackSession.swift:160-162`.

### Concern: QA index convergence reason loses some semantics

- The index includes the required manifest fields and ordered report refs, but `quality_floor` and `no_improvement` both become `score_plateau`.
- If Section 6.3's "convergence reason" is meant to preserve the loop result exactly, this is lossy.
- Relevant code: `qa-loop.ts:50-58`, `qa-loop.ts:202-210`, `qa-loop.ts:362-370`.

### Concern: Dashboard "Fixes" counts proposed fixes, not proven applied fixes

- `QADashboardDocument.totalFixesApplied` sums `report.fixes?.count`.
- In the QA loop, the report is written before apply/compile completes. If apply later fails and rolls back, the dashboard can still count those proposed fixes as fixes.
- Relevant code: `QADashboardDocument.swift:39-43`, `qa-loop.ts:156-181`.

## Checklist

| # | Area | Verdict | Notes |
|---|---|---|---|
| 1 | `qa-improvement-index.json` shape | Concern | Has version, project_id, run_id, base/result hashes, convergence reason, ordered report refs. Semantic concern on convergence mapping above. |
| 2 | `issues[]` contains all detected issues | Pass | `detectIssues(...)` is passed directly into `buildQAReport(...)`; only `proposeFixes` receives the fixable subset. |
| 3 | Backward compatibility with existing reports | Pass | Swift decodes `issues` as optional and falls back to `fix.issue` when the field is absent. Existing `qa-improvement-report-iter*.json` can still load. |
| 4 | Index-first load + legacy glob fallback | Pass | Loader uses index first, then numeric-sorted legacy glob when no valid index is present. |
| 5 | Radar chart two-series behavior | Pass | Canvas draws only `selects.*` blue and `blueprint.*` green; unqualified aliases are not drawn as a third series. |
| 6 | Issue click to playhead jump | Pass | Issue rows call `model.jumpToQATimestamp`, which seeks and selects the clip at that frame. |
| 7 | Tests cover decode, score, index paths | Fail | Swift covers decode round-trip, score properties, index and no-index paths. TS test exists, but it breaks `npm run build`. |
| 8 | Apply jumps to first changed clip | Concern | Works for target-clip mutations; insert-only patches are not covered. |
| 9 | 5-second changed highlight timer | Pass | Previous timer is invalidated, closure captures `self` weakly, and clear paths invalidate. No retain cycle found. |
| 10 | Keyboard shortcuts focus / `Cmd+Z` | Pass | Shortcuts are disabled unless `timelineFocused`; `Cmd+Z` is scoped to timeline focus. No AppKit menu `Cmd+Z` conflict found. |
| 11 | Promote skeleton extensibility | Concern | It is non-mutating and reads latest replace ops, but currently only emits a status string and has no runner boundary yet. |
| 12 | Existing tests / regression | Fail | Swift tests pass, target TS tests pass, but repo TS build fails. |

## Verification

- Pass: `npm test -- tests/qa-improvement-report.test.ts tests/qa-loop.test.ts` (10 tests)
- Pass: `swift build --target VideoOSStudio`
- Pass: `swift test` (188 tests)
- Fail: `npm run build` (`TS2352` in `tests/qa-improvement-report.test.ts`)
- Note: `git diff --check public/Dev..HEAD` also reports trailing whitespace in `docs/design-studio-feedback-loop.md:174` and `:403`; this is outside the requested code review target but still branch hygiene debt.
