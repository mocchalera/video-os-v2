# Lively ALT longform real-media run — 2026-07-14

## Outcome

- Project: `projects/lively-alt-longform-v1`
- Source: 9 chronological ALT assets, 168.185 minutes total
- Selected/rendered: 62.677 minutes, 29 chapters, 136 clips
- Output: `09_output/rough-cut.mp4` (3760.625 sec, 2,289,074,575 bytes)
- Streams: H.264 1920x1080 24fps + AAC 48kHz stereo
- Timeline: 90,369 compiled frames, zero gaps, chronological order preserved
- Render duration parity: pass (`-1.106 sec`, tolerance `1.879 sec`)

## Longform execution fixes proven by the run

1. Longform candidates now reference canonical `SEG_*` IDs from `segments.json`.
2. The compiler preserves exact `longform_reduction` candidate order and all 136 planned beats.
3. Audio mux inputs use per-window `-ss` and `-t`, reducing the 136-input mux from an impractical full-source scan to about two minutes while copying the existing video stream.
4. `--reuse-video` resumes audio mux/finalization without re-encoding the 63-minute video assembly.
5. File hashing is chunked, so render freshness metadata supports outputs larger than 2 GiB.
6. Review metrics treat same-source continuity and chapter-tag repetition as intentional only for `longform.mode: reduction`.
7. Hour-long render parity uses the stricter of 0.5 sec or 0.05% proportional tolerance.
8. Audio placement now uses a timeline-hash-bound `video-assembly-timing.json` containing the measured duration of every encoded clip. This prevents per-cut frame rounding from accumulating as lip-sync drift, including after `--reuse-video` resumes.
9. Ending treatment is profile-independent: the compiler extends the final source handle, records frame-exact audio/video fades, and keeps legacy blueprints byte-stable when no treatment is requested.
10. This run retains 3 seconds of source ambience, fades audio over 2 seconds, and fades video to black over 1.5 seconds.

## Verification

- `npm test`: 165 files passed, 4 skipped; 2685 tests passed, 39 skipped.
- `npx tsc --noEmit`: passed.
- Focused longform/render/state/review tests: 127 passed.
- Schema validation: 23 artifacts checked; timeline and review artifacts valid. One intentional project-level blocker remains because Marlin visual approval is unavailable.
- Deterministic review metrics: 10 pass, 0 warn, 0 fail, 0 skipped. Declared ending post-roll is excluded from beat pacing deviation.
- Nine visual samples across 60–3480 sec show valid event imagery and chronological speaker/session changes.
- Nine 10-second audio samples contain signal; sampled mean volume ranges from -41.8 dB to -28.0 dB.
- Exact sync audit: the ending sample at `CLP_0136` measured -0.333 ms audio offset. The final video/audio streams both end at 3760.625 sec.
- Ending fade audit: sampled video luma fell from 175.7 to 112.7 to 24.9; sampled audio RMS fell from -24.5 to -34.2 to -44.6 dB.

## Remaining human gate

Marlin visual QA could not access the gated `NemoStation/Marlin-2B` repository. The rough cut is available for review, but final/package status remains blocked until visual approval or a documented waiver. No unsafe automatic review patch was produced.
