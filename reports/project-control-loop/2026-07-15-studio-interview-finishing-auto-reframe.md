# Studio interview finishing and automatic reframe

Date: 2026-07-15

## Outcome

Studio now exposes the existing interview-finishing contract instead of
requiring hand-authored review patches. An editor can choose an MA preset,
preview and queue a static zoom/pan, or ask Vision for a conservative framing
proposal based on the subject's face, eyes, look direction, and visible hands.

The same proposal engine is available from `videoos-studio-cli
interview-reframe`, so the decision is reproducible outside the UI and can be
covered by automated tests.

## Friction removed

- `change_visual_transform` and `change_audio_finish` existed in the TypeScript
  schema/compiler path but not in Studio's Swift review-patch model.
- Studio had no native controls for interview MA or framing and no live pending
  transform preview.
- Reframing still required an operator to estimate zoom and position by eye.
- The shared filtergraph applied zoom first and then emulated position with a
  black pad/crop. A translated zoomed image could therefore expose a black
  edge. Position now pans the crop window inside the available zoom overscan and
  clamps to that safe area.

## Implementation

- Extended the Swift `ReviewPatchDocument` and feedback session with validated,
  deduplicated visual-transform and audio-finish operations.
- Added a native macOS **Interview finishing** inspector section with MA
  presets, zoom/X/Y sliders, safe-range clamping, reset/queue actions, progress
  and proposal evidence, and stable accessibility identifiers.
- Added a clipped live viewer preview for the selected clip. Captions and other
  overlay layers are not scaled with the source image.
- Added `InterviewAutoReframeAnalyzer` using AVFoundation and Vision face
  landmarks, eye center, yaw, and hand pose observations across representative
  source frames.
- Added a pure, deterministic planner. Normal interviews are capped at 1.18x,
  visible gestures tighten the cap to 1.15x, genuinely small faces may use up
  to 1.30x, and yaw proposals reserve look-room without exceeding safe pan.
- Added the same analyzer to `videoos-studio-cli interview-reframe` and updated
  the `finish-interview` skill and README.

## Verification

| Gate | Result |
| --- | --- |
| Swift package | 538 tests passed, 0 failed |
| Node repository suite | 2,742 tests passed, 39 skipped, 0 failed |
| TypeScript | `npx tsc --noEmit` passed |
| Studio app | build, ad-hoc signing, launch/window verification passed |
| Skill package | `quick_validate.py` passed |
| Fixed editorial suite | exit 0; AX-1 goldens remain 100 |

The repository-wide `--all --min-score 80` editorial gate remains non-zero for
the pre-existing `fumoto-growth` score of 52 and the existing negative
`src_in_us` validation failure in `rokutaro-bicycle-growth-20260427`. No new
editorial regression was found.

## Real AX-1 source proof

The analyzer was run against an operator-provided local interview fixture using
the first authored interview clip range (14.320000–53.732249 seconds) and nine
representative samples.

| Signal | Result |
| --- | --- |
| Face evidence | 9 / 9 samples |
| Gesture evidence | 0 / 9 samples |
| Proposal confidence | 0.985 |
| Zoom | 1.18x |
| Position | x -165.9 px, y -66.9 px |
| Visual check | balanced headroom/look-room; no black edge |

The source footage and project artifacts were not modified. The JSON proposal
and representative reframe image are retained as copied Project Loop evidence.

## Residual limits

- This is a static per-clip framing proposal. A walking or strongly moving
  subject still needs keyframed tracking, temporal smoothing, and a maximum pan
  velocity contract.
- Vision hand-pose detection is deliberately confidence-gated and may miss
  occluded hands. The proposal always remains a reviewable draft.
- Full-program loudness measurement and final visual approval remain output QA
  gates after the queued patch is applied and rendered.
