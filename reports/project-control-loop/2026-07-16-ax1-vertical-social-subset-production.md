# AX-1 vertical social short and local subset production proof

## Outcome

- Created an independent 61.1-second, 1080x1920, 30 fps AX-1 interview derivative at `projects/img-8155-interview-social-vertical-60s`.
- Kept four context-complete answers: owner-led adoption, owner self-practice, accounting rebuilt around AI with safe testing and human responsibility, and value for the owner and staff.
- Rendered one Remotion speech-caption layer and three HyperFrames-owned section labels without BGM.
- Used per-composition local WOFF2 subsets for both renderers with the bundled Noto Sans JP TTF as the common source.
- Preserved a moving 1.5-second silent tail and applied the final 30-frame black fade without freezing the source.

## Production defects found and fixed

### Landscape source to portrait crop

- `editor/shared/filtergraph.ts` previously derived crop X/Y from requested scale dimensions even though FFmpeg `force_original_aspect_ratio=increase` can produce a wider real intermediate.
- The crop now uses the real post-scale `iw` / `ih` dimensions and clamps the requested position inside valid bounds.
- `editor/tests/parity/filter-parity.test.ts` covers landscape-to-portrait output and `tests/render-rough-cut.test.ts` asserts the shared clamped expression.

### Non-zero Remotion overlay timing

- `runtime/render/remotion/components/TextOverlayLayer.tsx` previously evaluated preset hooks before entering the local `<Sequence>`, so overlays that started after frame zero inherited composition-global time and could already be faded out.
- Presets now render inside `OverlayPresetRenderer` under each local sequence.
- `tests/remotion-render-smoke.test.ts` renders a second non-zero overlay and verifies visible luma.

### Intentional cut breathing rejected by CLI sync guard

- `scripts/render-rough-cut.ts` previously rejected independent visual pre-roll and post-roll whenever video and audio durations differed, even when their source offsets and timeline offsets matched.
- The guard now permits breathing only when both start and end offsets match within tolerance; source/timeline disagreement remains a hard failure.
- `tests/render-rough-cut.test.ts` covers the accepted breathing case and the existing bad source-in mismatch remains rejected.
- Real CLI smoke completed at 61.1 seconds with duration parity delta 0.

### Japanese authored line breaks

- `runtime/render/remotion/styles/overlay-presets.ts` now applies `wordBreak: keep-all` and `overflowWrap: normal` to title-card captions.
- The project authors 19 speech captions at a maximum of two lines and ten characters per line, plus explicit semantic breaks in HyperFrames section labels.
- Visual contact sheets confirm no split particles or split words in the sampled long lines.

## Render and QA evidence

- Final preview: `projects/img-8155-interview-social-vertical-60s/09_output/ax1-social-v60-preview.mp4`
- SHA-256: `5df3eb59396513c21da9269b316fb228ea829bb3b9c8eb1fb1572a736cdfaf0b`
- Duration: video 61.100 s, audio 61.077333 s
- Video: H.264, 1080x1920, 30 fps
- Audio: AAC, 48 kHz stereo, -15.93 LUFS, LRA 6.10 LU, true peak -1.51 dBFS
- Final silence: 1.556354 s
- Moving tail check: 36 unique hashes from 36 sampled frames
- Captions: 19, overlap count 0, authored max two lines / ten characters per line
- Review metrics: pass 8, warn 1, fail 0, skipped 2
- Schema validation: 13 artifacts, 0 errors, 0 warnings
- HyperFrames 0.7.60 lint: 0 errors, 0 warnings

## Font subset evidence

| Renderer | Mode | Characters | Size | Subset SHA-256 |
|---|---:|---:|---:|---|
| Remotion captions | WOFF2 subset | 203 | 89,604 bytes | `c98b6477ffc7d34bb35b189e2baf9437095cee99ecb0879cedc5284feaa065be` |
| HyperFrames sections | WOFF2 subset | 118 | 53,688 bytes | `aaa756ae51dc50d18052d7f48e20f6c97ae75e48afcaa4ab857a82e35ab8176a` |

Both were generated from bundled source SHA-256 `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f` without network font loading.

## Verification

- `npx tsc --noEmit` — passed
- `npm run build` — passed
- `npx vitest run --reporter=json` — 824 / 824 suites passed; 2,774 tests passed; 0 failed; 39 skipped
- `VOS_REMOTION_RENDER=1 npx vitest run tests/remotion-render-smoke.test.ts` — 1 passed
- Targeted filter, assembler, rough-cut, font, content-element, and overlay tests — passed
- `npx tsx scripts/render-rough-cut.ts --project projects/img-8155-interview-social-vertical-60s --output /tmp/ax1-social-v60-cli-smoke.mp4` — rendered 4 clips, 61.1 s, duration parity passed
- `npx tsx scripts/validate-schemas.ts projects/img-8155-interview-social-vertical-60s` — valid, 13 artifacts

## Boundary

This is a local preview. Publication, ad delivery, rights approval, and performer approval remain human-gated and were not performed.
