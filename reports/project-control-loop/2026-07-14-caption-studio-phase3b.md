# Caption Studio Phase 3B verification — 2026-07-14

## Scope

- Shared caption review queue now exposes `fps`, `timeline_duration_frames`, and one-step `can_undo` state.
- Shared CLI/Core supports stale-protected text/timing edits, split, adjacent merge, and action-level undo.
- macOS Studio adds timeline-order navigation, real timeline preview loop, range waveform, frame timing controls, split/merge, debounced autosave, and undo.
- Caption rules remain in TypeScript Review Core; Swift only routes typed user actions through `scripts/caption-review.ts`.

## Verification

- `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm test`
  - 169 test files passed, 4 skipped.
  - 2712 tests passed, 39 skipped.
- `swift test --package-path apps/macos-studio`
  - 524 tests passed, 0 failures.
- `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsc --noEmit`
  - passed.
- `./script/build_and_run.sh --verify`
  - app built, signed, launched, and its main window passed the verification check.
- `git diff --check`
  - passed.

## Real Lively ALT read-only check

- Project: `projects/lively-alt-longform-v1`
- Caption queue: 1132 items at 24 fps.
- The queue exposes per-caption duration and text hash; the highest-risk item remains `SC_0362` with the expected Japanese phrase-break, density, fallback, and low-confidence findings.
- Timeline preview source is available from the current rendered outputs; `05_timeline/assembly-longform-video.mp4` duration is 3760.625 seconds.
- No caption patch, preview, approval, source footage, or rendered output was written during the real-project check.

## Visual check

- Studio sheet was opened in the running app and inspected at 1240 × 778.
- The initial attention queue now includes unreviewed captions even when they have no machine issue.
- Risk/timeline sorting, previous/next navigation, video/caption preview, waveform strip, timing steppers, split/merge, autosave, undo, reviewer gate, and approval affordances fit without clipping.

## Remaining acceptance work

- Run the full 1132-item Lively project inside Studio and verify loop playback at representative beginning/middle/end captions.
- Add glossary promotion and a multi-level history/conflict-resolution UI.
- Final approval/render parity remains a separate end-to-end gate.
