# F-0086 caption cross-path parity — green verification

## Repair

The final visual compositor now enters RGBA only when at least one visual
layer requires alpha compositing. Caption-only output applies the canonical
ASS subtitles filter directly to the base YUV video, matching the exact
preview path. Layer ordering, caption timing, caption styling, bundled fonts,
and the `0.999` SSIM threshold are unchanged.

## Focused verification

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run tests/final-visual-compositor.test.ts
```

Result: 3 passed. The caption-only graph contains the subtitles filter and no
`format=rgba`; layered composition retains its existing RGBA path.

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  PARITY=1 KEEP_PARITY_ARTIFACTS=1 \
  npx vitest run editor/tests/parity/final-parity.test.ts \
  -t "scenario: captions"
```

Result: 4 passed. Direct FFmpeg comparison of the generated preview and final
video reported `SSIM All:1.000000`.

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  PARITY=1 npx vitest run editor/tests/parity/final-parity.test.ts
```

Result: all 24 cross-path parity tests passed across cuts, talking-head cuts,
crossfade, J-cut, gap crossfade, and captions.

## Repository verification

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npm run verify
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npm run verify -- --full
```

Results:

- normal verification: all gates passed; 3,679 tests passed, 44 skipped
- full verification: all gates passed
- full render parity: 75 tests passed
- typecheck, demo schema validation, review metrics, and golden evaluation
  gates passed

No media was copied, modified, published, or uploaded.
