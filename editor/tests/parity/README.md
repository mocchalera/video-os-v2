# Editor Parity Tests (Phase 5)

These tests enforce the contract from `docs/editor-preview-render-parity-design.md`
sections 9.5 and 13: preview and final render must produce identical output for
the same `RenderSpec`.

## Test layers

| File | When it runs | What it asserts |
| --- | --- | --- |
| `filter-parity.test.ts` | always | Pure-function determinism for `buildVideoClipFilter` and `buildEffectFilter`. No ffmpeg. |
| `compare.test.ts` | only when `PARITY=1` and `ffmpeg` is on `PATH` | Real preview render → SSIM ≥ 0.999, integrated LUFS diff ≤ 0.1 LU, caption text/timing exact match. |

The default test run never invokes `ffmpeg`. Set `PARITY=1` to enable the heavy
parity comparisons in CI.

## Running

From the repo root (the root `vitest.config.ts` already discovers
`editor/tests/parity/*.test.ts`):

```bash
# Fast: filter parity only
npx vitest run editor/tests/parity/filter-parity.test.ts

# Full: also run the SSIM/LUFS comparisons (requires ffmpeg)
PARITY=1 npx vitest run editor/tests/parity/
```

## Helpers

- `frame-extract.ts` — extract a single PNG frame from a video at a given second.
- `ssim.ts` — compute SSIM between two videos using ffmpeg's `ssim` filter.
- `lufs.ts` — measure integrated LUFS via 2-pass `loudnorm` (matches the
  preview job service mastering algorithm).

## Pass criteria (Section 13.3)

- frame hash or SSIM ≥ 0.999
- caption text and cue timing exact match
- integrated LUFS diff ≤ 0.1 LU
- true peak diff ≤ 0.2 dBTP
