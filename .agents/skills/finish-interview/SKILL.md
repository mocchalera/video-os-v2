---
name: finish-interview
description: Apply repeatable dialogue MA, Studio-based or automatic portrait reframing, overlay-safe rendering, and loudness/sync QA to an existing interview or talking-head rough cut. Use when the user asks to make speech easier to hear, perform MA, enlarge or rebalance a person in frame, crop or punch in an interview, automatically propose framing, or prepare a finishing preview before final approval.
---

# Finish Interview

Use canonical timeline metadata and the shared renderer. Do not handwrite a
one-off ffmpeg graph unless the project's downstream overlay format cannot be
represented by the timeline.

## Workflow

1. Read `05_timeline/timeline.json`, `06_review/review_patch.json`, the latest
   preview, and any downstream card/caption artifacts.
2. Measure before changing:
   - create a representative frame contact sheet;
   - measure integrated LUFS, true peak, and LRA;
   - probe video/audio start times and durations;
   - record `avg_frame_rate`, `r_frame_rate`, and `time_base`; treat a phone
     source whose cadence cannot be proven CFR as VFR for sync review.
   - when choosing framing automatically, run
     `.build/debug/videoos-studio-cli interview-reframe --source=<video> --in-us=<n> --out-us=<n>`;
   - treat its face/eye/yaw/hand result as a proposal, then inspect representative frames.
3. Keep editorial timing unchanged unless the user separately requests a cut.
   For a titled J-cut opening, stage information instead of presenting exterior,
   title, and dialogue at the same instant: establish the exterior, let the title
   read, then fade dialogue in before the title exits. Enter the interview on a
   moving source frame, never a frozen bridge frame. Preserve the complete final
   utterance and a short moving-picture tail; do not extend the ending with a
   freeze frame.
4. Write review patch operations:
   - one `change_visual_transform` per affected video clip;
   - one timeline-level `change_audio_finish` operation.
   Studio can author both operations from the selected clip's
   **インタビュー仕上げ** inspector. Adjusted framing appears immediately in the
   Viewer; press **画角を保留** and **MAを保留** before Apply & Preview.
5. Apply the patch with `scripts/compile-timeline.ts --patch` and require schema
   validation to pass.
6. Render the clean assembly first. Burn captions and insert question cards
   afterward so zoom/crop never scales authored graphics.
7. Verify the final preview by full decode, loudness measurement, visual frame
   sampling, audio/video duration comparison, and dialogue placement QA. The
   duration comparison alone is insufficient: package QA must show
   `dialogue_timeline_alignment_valid` as well as `av_drift_valid`.

## Patch pattern

```json
{
  "timeline_version": "1",
  "operations": [
    {
      "op": "change_visual_transform",
      "target_clip_id": "CLP_0001",
      "visual_transform": {
        "zoom": 1.15,
        "position": { "x": -144, "y": -39 }
      },
      "reason": "Increase portrait presence while preserving look room"
    },
    {
      "op": "change_audio_finish",
      "audio_finish": {
        "preset": "dialogue-clean",
        "loudness_target_lufs": -16,
        "true_peak_target_dbtp": -1.5
      },
      "reason": "Improve speech intelligibility and delivery loudness"
    }
  ]
}
```

`position` is measured in output pixels. Negative `x` shifts the image left;
negative `y` shifts it upward. Start around `zoom: 1.10–1.18` for a restrained
talking-head punch-in and inspect hand gestures across the whole cut.

For `zoom > 1`, position pans inside the available zoom overscan and clamps at
the source boundary. Do not recreate the old post-crop pad/translate graph; it
exposes black edges. The automatic planner normally caps an interview punch-in
at 1.18, reduces it when hands are detected, and allows stronger zoom only when
the detected face is genuinely small.

## Audio presets

- `dialogue-clean`: 70 Hz high-pass, gentle noise reduction, mud/presence EQ,
  3:1 compression, and measured two-pass loudness normalization.
- `loudness-only`: measured two-pass normalization without cleanup or EQ.
- `none`: disables the declared finish preset.

Defaults target `-16 LUFS`, LRA 7, and `-1.5 dBTP`. The dialogue preset keeps
0.3 dB of codec headroom before AAC encoding.

## QA contract

- No cropped head, hands, or interviewer look room in representative samples.
- Captions and question cards retain their authored size and position.
- Integrated loudness is within 0.5 LU of target.
- Encoded true peak does not exceed the declared target by more than 0.2 dB.
- Audio/video start at zero and end within one frame.
- Dialogue-only signal stays inside the timeline windows that own dialogue.
  `adelay=...,atrim=start=0` on one input branch is forbidden because the trim
  removes the inserted lead-in; source `atrim` must precede `adelay`, and only
  the final mixed output may be duration-trimmed.
- For VFR phone footage, first choose the intended video frame, then measure the
  video and audio source offsets independently. If frame quantization leaves a
  sub-frame residual, keep the chosen picture frame and offset audio by the
  measured residual. Do not chase sync by repeatedly moving the video trim
  across frame boundaries.
- A proxy or alternate encode made to diagnose a player is diagnostic only. It
  must not become the canonical creative output or constrain title/J-cut timing.
- Full ffmpeg decode exits successfully.
- Keep preview output distinct from final package output until caption and
  review gates are approved.
