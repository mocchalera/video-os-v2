# Longform event mode implementation evidence

Date: 2026-07-13 JST

## Implemented slice

- Added `longform-event` profile, `longform-documentary` policy, and `longform_reduction` skill card.
- Added transcript-first primary-lane selection, utterance windows, chapter allocation, exclusion reasons, exact trims, chronological blueprint generation, and an 85–115% fail-closed duration gate.
- Added schema fields for longform configuration and inspectable `longform_plan` metadata.
- Connected the mode to the canonical `npm run full-pipeline` / `scripts/editorial-pipeline.ts` route and to command-based triage/blueprint.
- Preserved the existing short `event-recap` profile and the shared compiler/render/QA stages.

## Lively ALT read-only planning smoke

The existing `projects/lively-alt-vol5` analysis artifacts were read without modifying the project. The brief was overridden only in memory with a 3,600-second strict target and `profile_hint: longform-event`.

| Measurement | Result |
|---|---:|
| Source duration | 10,091.105 s (168.2 min) |
| Unioned transcript speech | 9,958.286 s |
| Selected duration | 3,762.296 s (62.7 min) |
| Keep ratio | 0.3728 |
| Chapters | 29 |
| Candidates / beats / compiled clips | 136 / 136 / 136 |
| Compiled timeline duration | 3,762.375 s |
| Planner coverage | `ready` |
| Duration policy | `pass` |
| Compile time | 147 ms |

The filename groups named January and June did not have enough transcript overlap to prove that they were alternate camera coverage, so the safety gate retained all nine assets. Automatic lane exclusion now requires both comparable duration and at least 35% normalized transcript overlap. Recorded interval exclusions included duplicate utterances, low-priority windows, housekeeping, silence, filler, and short invalid fragments.

## Verification

- `npm run verify`: passed. Typecheck, full unit suite, demo schema validation, and demo review-metrics command all completed successfully.
- Final `npm test -- --reporter=dot` after the lane-safety change: 164 test files passed, 4 skipped; 2,674 tests passed, 39 skipped.
- `npm run build`: passed.
- `npm run verify:repo`: passed for 1,452 tracked files.
- Focused longform tests: 7 passed, including canonical editorial-pipeline routing, safe non-overlapping filename lanes, schema validation, fail-closed insufficient coverage, and shared compiler output.
- Cross-profile targeted regression: 11 files and 204 tests passed before the canonical-entrypoint test was added.

The first full test run exposed only a pre-existing local ABI mismatch: `better-sqlite3` had been built for Node ABI 137 while this repository requires Node 22 / ABI 127. `npm rebuild better-sqlite3` under Node 22 repaired the local dependency without changing manifests or lockfiles; the complete suite then passed.

## Remaining gate

This evidence proves planning and compile scalability, not final media quality. A real one-hour render, A/V sync inspection, chapter-sampled visual/audio QA, confident multicamera angle switching, and visual-only dead-time repair remain open under goal G-0006.
