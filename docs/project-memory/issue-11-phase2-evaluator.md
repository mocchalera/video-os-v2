# Issue #11 — Phase 2 assembly-loss evaluator

- evaluator: `assembly-loss/v1`
- public path: `scripts/eval-assembly-loss.ts` -> `runtime/eval/assembly-loss-project.ts` -> `runtime/eval/assembly-loss.ts`
- output: noncanonical JSON + Markdown + detached SHA-256 sidecars
- Day2 report input hash: `d10ed45f1f6c5eea286beec1e093b65a59a64786a8e1715fa6d3e509475e8c2e`
- policy hash: `5fcc04367b733d506bfd7a896ac8795ba566308509ca3d23a22d1f4afb9cec92`
- JSON SHA-256: `2caf658940e848f5f606fb7bc02094ccf03b82073adb260214ead805bbbdf4e3`

## Contract

The evaluator reads only validated brief/selects/blueprint/timeline,
sorted transcripts, and explicitly supplied optional references. It does not
create a planning source of truth, query a DB/graph, call a model/provider,
rank proposals, or mutate canonical artifacts.

Malformed, stale-shape coverage, missing required artifacts, path escape,
mixed/tampered report identity, and raw-hash/parse races fail closed. Missing
optional transcripts or causal/human references fail open as unavailable.
Coverage failure still produces a valid diagnostic with verdict `HOLD`.

ASR tolerance is 250,000 microseconds. The report states the rationale:
provider word timing can jitter about 100–200 ms relative to true audio
boundaries, so sub-tolerance differences are measurement noise.

The implementation sorts clips/utterances/edges, unions source speech spans,
and uses bounded overlap lookup. Its honest output-sensitive bound is
`O((C+U+E) log n + K)` time and `O(C+U+E+K)` memory, where K is the emitted
speech-intersection fragments. It performs no all-pairs or vector inference.

## Day2 observation

The public CLI ran twice with identical inputs. JSON, Markdown, and both
sidecars were byte-identical on rerun; detached sidecar verification passed.
Canonical aggregate SHA remained unchanged.

Verdict: **HOLD** because selects coverage is `failed` and analysis coverage
is `blocked`. The measured target is the existing human-fixed canonical
timeline, not an A1 auto-assembly output.

Observed values:

- important utterances: 35; full 8; head cut 2; tail cut 3; both cut 5;
  missing 17; retention ratio 0.2285714286
- total head loss: 26.659844 s; total tail loss: 51.499749 s
- kickoff-preceding action/support texture: 1 clip, 1.866667 s
- setup/payoff: both present, order ok; causal edge evidence unavailable
  (edge absence is not asserted as absent causality)
- no-speech duration: 0 s; longest uninterrupted no-speech interval: 0 s
- ambient/nat-sound union: 57.666667 s, observation only and never a gate
- story-role order: hook -> setup -> experience -> closing; adjacent rank drops 0
- human structural changes: unavailable because no explicit comparison input
- wall-clock inside report: unmeasured; CLI wall time was measured externally
  as 0.64 s then 0.42 s

These values are retained observations only. They are not a capability score,
fitness value, ranking signal, or success claim.

## Phase 2.5 and Phase 3

Phase 2.5: **not entered**. A1 stopped before assembly, so no evidence attributes
loss to cut density or max-shot-length policy.

Phase 3: **entry denied**. Coverage/grounding failure is present, no A1 loss
report exists, no operator mandatory-repair record exists, and no evidence
shows trim-insufficient structural repair. The five precommitted conditions are
not all satisfied.

## Verification disposition

- Fresh review `60061ee8` ran against exact target
  `66f1a5a51b87d0255a3fdaf5d5a0e9ce83e0762e` and direct parent
  `372b26891a6ef833121fd35ad688eb428cfd8715` with Node 22.23.1 / npm 10.9.8.
- The focused command was `npx vitest run` over the 12 Issue #11 evaluator,
  compiler, policy, coverage, and Skill-contract test files: 12 files / 182
  tests passed (the earlier 192 count was incorrect).
- `npm run typecheck`, `npm run typecheck:editor`, and `npm run build`: passed.
- `npm run test:schema-contract`: 93 passed / 1 skipped.
- `npm run verify:skill-contracts`: 39 documents / 64 artifacts / 0 errors /
  0 warnings. `npm run verify:repo`: 2,202 tracked files passed.
- Target `npm test`: 339 files / 4,696 tests passed, with 6 files / 54 tests
  skipped. Direct parent: 337 files / 4,631 tests passed with the same skips.
- Target `npm run verify -- --full`: every gate passed, including render parity
  75/75.
- Target and direct-parent `npm run validate:all-local`: identical baseline
  tuple, 6 projects / 62 artifacts / 13 errors / 0 warnings. This remains
  baseline HOLD rather than green.
- The older parent comparison mirror was based on `d13ad991...`, not direct
  parent `372b268...`. Its sibling-fixture `ENOENT` is retained as intermittent
  HOLD evidence; the fresh green run does not erase or relabel that history as
  resolved.

The fresh-review commands ran in the repo-external proper mirrors under
`/tmp/video-os-issue11-fresh-review.85dEH5`. The historical parent mirror whose
intermittent result is retained was the `d13ad991...` mirror, not a
`372b268...` direct-parent mirror. All mirrors used real hardlinked dependency
contents, independent Git indexes, and dedicated temporary directories;
canonical/user assets were not cleaned or modified.
