# T-0052 clean-source vertical-short acceptance

Date: 2026-07-26
Task: T-0052
Goal: G-0012
Project fixture: `ai-reboot-short-human-challenge-20260226`

## Scope

Run one local, deterministic, real-media vertical-short workflow from a
source-identity-verified clean original. Stop before caption approval, final
packaging, or publication.

The source manifest matched the local media:

- SHA-256:
  `6e5087527f3c6fcd9ed281bf5e649b6ddc72d195bd2691074a56922a5f46e7ac`
- Size: `252884832` bytes
- Duration: `2705.705215` seconds
- Video: H.264, 1280x720, 30000/1001
- Audio: AAC stereo, 44100 Hz
- Distributed full-duration frame sampling found no burned-in speech captions.
- Rights and privacy status remain `unknown`; this evidence is local-only and
  does not authorize publishing.

## Fail-first findings and fixes

1. **D-0021 / F-0087 — strict duration gate**
   - Before: a strict 47-second brief compiled and rendered only 6 seconds,
     while reporting success.
   - After: `compile-timeline` fails before render when `hard_gate=true` and
     `duration_fit=false`, including the actual and allowed frame counts.
   - Regression: `TC-0153`.

2. **D-0022 / F-0088 — canonical rough-render dimensions**
   - Before: a 1080x1920 timeline emitted a 1920x1080 rough cut.
   - After: rough-render clip filters receive the timeline sequence width and
     height.
   - Regression: `TC-0154`.

3. **D-0023 / F-0089 — complete utterance at a frame cap**
   - Before: a complete 45.631187-second statement was rejected against an
     exact 45.625-second microsecond cap even though both resolve to 1095
     timeline frames. Snapping selected a semantically dependent fragment.
   - After: utterance duration bounds use the same half-frame rounding window
     as timeline duration.
   - Regression: `TC-0155`.

4. **D-0024 / F-0090 — source cadence before frame trim**
   - Before: the shared assembler applied `trim=end_frame=1095` to 29.97 fps
     source before conversion to 24 fps, emitting 878 frames / 36.583 seconds.
   - After: the filter normalizes to the rational timeline fps before applying
     the frame-count trim.
   - Regression: `TC-0156`.

5. **D-0025 / F-0091 — clean finishing assembly**
   - Before: a finishing preview either burned legacy placeholder captions or
     had to use the package-only reject mode.
   - After: explicit `legacyCaptionMode: "omit"` renders the clean picture
     layer; package callers retain the fail-closed `"reject"` contract.
   - Regression: `TC-0157`.

## Real-media green result

Local review artifact:

`tmp/t0052-real-short-green-20260726/ai-reboot-short-human-challenge-vertical-acceptance/09_output/rough-cut-clean-finished.mp4`

- SHA-256:
  `dd1d654c9cefa22ae8471e3c5a9591a9838eeaf7461ef3aab407535e668d079b`
- Size: `34123939` bytes
- Video: H.264, 1080x1920, 24/1 CFR, 1095 decoded frames
- Audio: AAC stereo, 48000 Hz
- Video start/end: `0.000000` / `45.625000`
- Audio start/end: `0.000000` / `45.625000`
- Integrated loudness: `-16.0 LUFS`
- True peak: `-1.8 dBFS`
- Full ffmpeg decode: passed
- Deterministic review metrics: 8 pass, 0 warn, 0 fail, 8 not applicable
- Dialogue completeness: passed
- Speech-cut boundary: passed
- Visual sampling: portrait framing retained the speaker, microphone, and
  representative gestures without placeholder captions.

## Repository verification

Node: `22.23.1`

Command:

```sh
npm run verify -- --full
```

Result:

- Typecheck: passed
- Unit tests: 251 files passed, 6 skipped
- Tests: 3682 passed, 44 skipped
- Demo schema validation: passed
- Golden editorial agreement gate: passed
- Render parity: 75 passed
- Overall: all gates passed

## Remaining gate

The clean rough needs human editorial approval. Caption authoring/approval,
final-render approval, package QA, and publication were not performed.
