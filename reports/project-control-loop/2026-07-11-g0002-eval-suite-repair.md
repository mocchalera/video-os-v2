# G-0002 eval suite repair evidence

- Date: 2026-07-11 JST
- Scope: D-0011 / F-0035
- Branch: `Dev`

## Outcome

The integrated golden suite now has a deterministic baseline:

- brief-alignment live judges are disabled unless `--judge` is supplied;
- live Marlin visual QA is disabled unless `--marlin` is supplied;
- `--no-write` is propagated to the Marlin report boundary;
- incompatible legacy golden timelines are recorded as `skipped(golden_timeline_incompatible)` instead of aborting the suite;
- the CLI flag mapping and all boundaries above have permanent regression coverage.

## Verification

Environment:

```text
node v22.23.1
npm 10.9.8
```

Commands and results:

```text
npx tsc --noEmit
PASS

npx vitest run tests/eval-suite.test.ts tests/marlin-qa.test.ts tests/qa-loop.test.ts tests/m4-qa.test.ts tests/e2e-m4.test.ts tests/qa-measure.test.ts
6 files passed; 94 tests passed

npx vitest run tests/eval-suite.test.ts
1 file passed; 8 tests passed

npm run verify
161 files passed, 4 skipped; 2636 tests passed, 39 skipped
schema validation: 15 artifacts, 0 errors, 0 warnings
all gates passed
```

The documented Node 22 CLI path completed with exit code 0:

```text
npm run eval -- --suite golden --no-write

fumoto-growth   structure/alignment=52.0  marlin=—  divergence=skipped(marlin_qa_score_unavailable)
togakushi-camp  structure/alignment=—     marlin=—  divergence=skipped(only_reference_alignment_score_available)
ena-promo       structure/alignment=—     marlin=—  divergence=skipped(only_reference_alignment_score_available)
```

Explicit Marlin routing was also exercised without report output:

```text
npm run eval -- --suite golden --projects fumoto-growth --marlin --no-write
exit 0; Marlin stage skipped honestly because the canonical fresh render is absent
```

## Residual gap

G-0002 is not ready to close. The fixed suite is reproducible, but the three configured projects do not currently provide a verified live-Marlin comparison matrix:

- all three lack a canonical fresh `09_output/rough-cut.mp4`;
- `togakushi-camp` has a legacy timeline shape that is incompatible with the current Timeline IR schema;
- `ena-promo` has no canonical `05_timeline/timeline.json`;
- therefore no structure-versus-Marlin divergence is currently computed.

The next bounded task is to normalize or regenerate the three golden timeline/render artifacts and run `--marlin` with non-mock provenance. This evidence should remain distinct from the deterministic baseline.
