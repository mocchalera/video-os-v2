# D-0014 — Ena exact human-golden contract repair

Date: 2026-07-11 JST
Goal / feature: G-0002 / F-0035
Task / workflow: T-0024 / WR-0042

## Outcome

The three configured Golden projects now have current Timeline IR artifacts and
complete deterministic structural results:

| project | structural score | placements | frames | continuity |
| --- | ---: | ---: | ---: | --- |
| `fumoto-growth` | 52.0 | 23 | existing 30 fps golden | completed |
| `togakushi-camp` | 100.0 | 29 / 29 | 2825 / 2825 | 0 reorder / 0 warning / 0 error |
| `ena-promo` | 100.0 | 100 / 100 | 4190 / 4190 | 0 reorder / 0 warning / 0 error |

Live Marlin was intentionally not requested in this structural run, so all
three visual-QA stages remain honestly skipped rather than synthesized.

## Root cause

The decoded Ena human edit contains multiple source-window occurrences from
the same segment and asset. Its assembler emitted `segment_id` references,
which were ambiguous for exact placement. The generic compiler also:

- filtered authored support placements outside a beat's broad role rubric;
- allowed Marlin trim planning to rewrite operator-authored source windows;
- dropped four explicit 11-frame placements under the generic 12-frame floor;
- treated distinct authored occurrences from the same asset as accidental
  continuity repeats; and
- compared the 100 concrete video placements with the 229.75-second export
  envelope, even though gaps, generators, transitions, and unresolved compound
  placeholders are excluded from this structural golden.

## Repair

- Ena candidate plans now use occurrence-stable `candidate_id` references.
- Ena beat budgets and duration policy are derived from frame-quantized concrete
  source windows; the exact content total is 4190 frames at 24 fps.
- Explicit candidate-plan placements remain eligible even when their role is
  outside the beat's broader required/preferred role rubric.
- `human_golden_order` preserves authored source windows instead of applying
  Marlin trim plans.
- Authored sub-12-frame placements are retained and tagged
  `intentional_short_clip: true` with reason `human_golden_order`.
- Exact-plan continuity exemptions now recognize repeated assets and semantic
  clusters across distinct occurrence IDs.
- Existing editorial metadata is merged rather than overwritten, so the short
  placement contract remains visible in the final Timeline IR.

## Reproducibility evidence

Ena:

- 100 expected / 100 actual placements;
- expected and actual candidate order SHA-256:
  `9351210a1c94a0fb8c4056fd42cd351f32eb668f1ead33f772a4ea35fa23e70a`;
- 4190 total / target frames, content fill 1.0, all six beat fill ratios 1.0;
- 100 A1 original-audio mirrors;
- four intentional 11-frame placements retained (`CLP_0006`, `CLP_0011`,
  `CLP_0058`, `CLP_0099`);
- timeline SHA-256:
  `9ae91fd451322d11d96899cb50c5ce371446431eae680a074bb64182c32bf4f7`.

Togakushi:

- legacy timeline SHA-256 backed up unchanged as
  `313e7b8d8e3f34377f9c619b20e7bcea39f4acabeb06bd44c0808a7be0361776`;
- 29 expected / 29 actual placements;
- 2825 total / target frames, all six beat fill ratios 1.0;
- 29 A1 original-audio mirrors;
- current Timeline IR SHA-256:
  `eb26c02751ac7d31bf63269479c8909425e650995f231dcc666fc94da63bf57c`.

Two consecutive `--skip-preview --skip-confirmations` compiles reproduced both
timeline hashes byte-for-byte.

## Verification

```text
npx vitest run tests/assemble-ena-golden.test.ts tests/peak-detection.test.ts \
  tests/compiler.test.ts tests/v1-first-layout.test.ts tests/compiler-continuity.test.ts
# 5 files passed; 69 tests passed

npx tsc --noEmit
# passed

npm run eval -- --suite golden --no-write
# fumoto-growth 52.0; togakushi-camp 100.0; ena-promo 100.0

npm run verify
# 162 files passed, 4 skipped; 2650 tests passed, 39 skipped

npm run verify:repo
# repo hygiene passed for 1415 tracked files
```

## Artifact boundary and residual gap

Canonical project directories are gitignored. The regenerated Ena planning and
timeline artifacts and the normalized Togakushi timeline remain local and are
not committed. No source footage, render, environment file, or generated media
is staged. No push was performed.

Ena still lacks a complete `source_map.json` and has seven decoded DJI fallback
occurrences without matching canonical `assets.json` / `segments.json` rows.
Those gaps do not block deterministic Timeline IR compile or Golden structural
evaluation, but they do block a trustworthy canonical render and live-Marlin
stage. They remain the next bounded artifact-recovery task.
