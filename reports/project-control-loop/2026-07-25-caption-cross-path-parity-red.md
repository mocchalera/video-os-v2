# F-0086 caption cross-path parity — red baseline

## Reproduction

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  PARITY=1 KEEP_PARITY_ARTIFACTS=1 \
  npx vitest run editor/tests/parity/final-parity.test.ts \
  -t "scenario: captions"
```

Result: caption duration and loudness passed, but video SSIM was
`0.996901`, below the unchanged `0.999` acceptance threshold.

Focused contract test:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run tests/final-visual-compositor.test.ts
```

Result: 1 failed, 2 passed. The caption-only compositor graph contains
`format=rgba` before the ASS subtitles filter.

## Root cause proof

The preview path applies the canonical ASS subtitles filter directly to the
YUV base. The final compositor converts the entire base to RGBA even when
there are no alpha layers, applies the same ASS subtitles, then converts back
to YUV.

Using the generated final ASS and bundled font with a direct YUV subtitles
filter produced `SSIM All:1.000000` against preview. The current RGBA final
path reproduced `SSIM All:0.996901`.

The repair must bypass RGBA only when no visual layers require alpha
compositing. Layered compositions must retain their existing RGBA ordering,
and the SSIM threshold must remain `0.999`.
