# Caption Studio Phase 3C verification

- Date: 2026-07-14
- Scope: glossary proposal, multi-level undo, stale conflict resolution
- Product posture: high-density native macOS editor; precise, calm, editorial
- Signature: Precision Instrument with frame/risk/history metrics and low-motion state changes

## Implemented

1. `caption_review_patch.json` keeps additive `action_operation_counts`; legacy `last_action_operation_count` remains readable.
2. `glossary-propose` stores canonical spelling, variants, and source caption IDs as a reversible `propose_glossary_term` operation.
3. Queue JSON exposes `undo_depth` and current `glossary_proposals` to Studio.
4. Queue items retain machine-draft `source_text`, so glossary variants are not learned from the already-corrected text.
5. Studio provides a project-glossary proposal sheet without auto-writing the canonical glossary or changing verified captions.
6. A stale save refreshes the shared queue and presents loaded/current/working versions with explicit resolution actions; keeping the working version suppresses autosave until explicit save.

## Verification

- Targeted TypeScript: 2 files, 16 tests passed.
- TypeScript typecheck: passed with Node 22.23.1 explicit runtime.
- Full TypeScript: 169 files passed, 4 skipped; 2713 tests passed, 39 skipped.
- Targeted Swift: 5 tests passed.
- Full Swift: 525 tests passed, 0 failures.
- `swift build --target VideoOSStudioCore`: passed.
- `swift build --target VideoOSStudio`: passed.
- `./script/build_and_run.sh --verify`: passed.
- `git diff --check`: passed.

## Real Lively ALT evidence

- Studio selected `lively-alt-longform-v1` and loaded all 1132 captions.
- Studio displayed the real timeline preview, waveform, caption overlay, frame timing, and glossary proposal control at `SC_0362` around 19 minutes.
- Headless queue remained read-only: no caption review patch, preview, approval, glossary proposal, or undo history was created.
- Beginning/middle/end queue samples: `SC_0001` frame 0, `SC_0583` frame 46486, `SC_1166` frame 91098.
- Existing finished preview duration: 3793.875 seconds. Visual samples were inspected near 00:05, 32:17, and 63:10.
- macOS requested removable-volume access while resolving some original media. Permission was not granted or denied by the agent; cached timeline preview evidence was used.

## Remaining human gate

Full representative beginning/middle/end loop playback inside Studio remains unpassed until the operator grants the macOS media access permission. Human approval and final render parity also remain unpassed.
