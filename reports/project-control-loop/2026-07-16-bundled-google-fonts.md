# Bundled Google Fonts renderer parity

Date: 2026-07-16
Project Loop feature: `F-0062`

## Outcome

The rendering stack now uses one network-free font contract:

- `font_id`: `noto-sans-jp`
- family: `Noto Sans JP`
- source: Google Fonts `ofl/notosansjp/NotoSansJP[wght].ttf`
- size: 9,589,900 bytes
- SHA-256: `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`
- license: SIL Open Font License 1.1, retained as `OFL.txt`

Google Fonts is not contacted during preview or final rendering. The binary is
staged from the repository and unknown font IDs fail closed.

## Connected surfaces

- HyperFrames uses local `@font-face`; the project writer always stages the
  font and license beside `index.html`.
- Remotion copies the same assets into `public/fonts` and delays capture until
  `document.fonts.ready`.
- FFmpeg/libass preview, pipeline burn-in, and promo finishing use the bundled
  `fontsdir`.
- FFmpeg drawtext uses the exact `fontfile` rather than system discovery.
- Caption style presets and caption review JSON expose the stable `font_id`.
- Studio packages the same file as a SwiftPM resource and registers it with
  CoreText before the first window is created.

## Verification evidence

Environment commands were run with Node `v22.23.1` and npm `10.9.8`.

| Verification | Result |
| --- | --- |
| Targeted TypeScript tests | 6 files, 46 tests passed |
| Full TypeScript test suite | 175 files passed, 4 skipped; 2,767 passed, 39 skipped |
| Root TypeScript typecheck | passed |
| Root TypeScript build | passed |
| Editor server typecheck | passed |
| Full Swift suite | 538 passed |
| Swift Studio build | passed; font and OFL copied |
| Studio launch smoke | no bundled-font registration error |
| Remotion render smoke | 1 passed; H.264/yuv420p output |
| FFmpeg/libass font verification | `fc_scan_match=true`, `ffmpeg_libass_match=true` |
| FFmpeg caption sample hash | `015ea30ba69304fe2f4c07ea6931886d0828502121f5bee7cfb123f0eb6a3157` |
| HyperFrames decoded determinism | matching hash across two renders |
| HyperFrames decoded hash | `SHA256=ad4ba0d8e2607bf60ed7a364904480727af8bb1ab7a0dca9847f49572b1f9c4a` |
| HyperFrames alpha/background SSIM | `0.974321` |

The Swift resource copy retained the canonical font SHA-256 exactly.

## Residual consideration

The full variable font adds 9.59 MB. The first uncached five-second HyperFrames
run took 44.652 seconds and 16.673 seconds; after caches were populated, the
final self-contained writer rerun took 14.936 seconds and 12.752 seconds with
the same decoded hash. This is correct and deterministic but not yet the
desired interactive exact-preview latency. A future optimization may generate
deterministic local per-composition subsets or ship a pinned unicode-range
WOFF2 cache. The full TTF remains the final-render and Studio fallback, and
runtime network loading remains prohibited.
