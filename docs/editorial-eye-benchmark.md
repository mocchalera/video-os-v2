# Editorial Eye benchmark contract

The v1 benchmark manifest is an exact 7 genre x 5 media-kind matrix. The suite describes cases and applicability only; it never supplies candidate predictions. Evaluation requires an explicit results artifact whose case, genre, media, generator, label, and manifest identities match.

The committed labels keep automatic ground truth separate from human annotations. Automatic facts are limited to objectively probed generated-media properties: decoded-frame fingerprints, stream topology, duration, audio presence, and RMS. Shared lavfi fixtures do not pretend to encode genre narrative or editorial intent, and do not receive pair/transition labels because they contain no verified multi-shot cut pattern. Genre intent stays on the unapproved human axis and is therefore `unmeasured`.

This committed baseline is a deterministic metric-adapter oracle, not a pipeline or model quality score. It proves schema, identity, denominator, and metric behavior. EYE-080C must connect real pipeline-produced results before Editorial Eye can measure model/editor quality. Sequence generation is probed as a generator capability, while the editing pipeline remains explicitly `unsupported` for sequence cases.

## Immutable fixture baseline

- Baseline commit: `e431da43c7fe7f4f50a688c3e8fcb48b50511453`
- Manifest canonical SHA-256: `454df2fd5fdc94a740990b1b5c5342b8f407dd379d973cc2854f40214a25824c`
- Baseline report raw-byte SHA-256 lock: `3adbfb07a22da0d2e9fc0a78e223121efeb964cf7a053689c134e0809053a88d`

```sh
npx tsx scripts/eval.ts \
  --suite editorial-eye \
  --manifest tests/fixtures/editorial-eye/v1/suite.json \
  --labels tests/fixtures/editorial-eye/v1/labels.json \
  --baseline-report tests/fixtures/editorial-eye/v1/baseline-report.json \
  --baseline-report-sha256 3adbfb07a22da0d2e9fc0a78e223121efeb964cf7a053689c134e0809053a88d \
  --results tests/fixtures/editorial-eye/v1/results.json \
  --candidate-commit e431da43c7fe7f4f50a688c3e8fcb48b50511453 \
  --no-write
```

## Generated-media probes

`--no-write` prints only the deterministic lavfi specification and does not create the output root:

```sh
npx tsx scripts/eval/generate-editorial-eye-fixtures.ts --output-root /tmp/editorial-eye --no-write
```

A measured regeneration first writes media outside the repository, then binds decoded frame fingerprints, stream topology, duration, and audio RMS into the committed contract artifacts. Generated media bytes are not committed.

```sh
npx tsx scripts/eval/generate-editorial-eye-fixtures.ts --output-root /tmp/editorial-eye
npx tsx scripts/eval/build-editorial-eye-benchmark-fixtures.ts \
  --generated-media-manifest /tmp/editorial-eye/generated-media-manifest.json \
  --output-root tests/fixtures/editorial-eye/v1
```
