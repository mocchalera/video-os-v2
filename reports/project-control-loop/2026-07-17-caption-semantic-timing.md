# Caption semantic timing feedback implementation

Date: 2026-07-17
Feature: F-0067
Story: US-0039

## Feedback translated into policy

The failure was not limited to punchlines. Speech captions were disclosing spoken
content well before the referenced utterance began.

The shared caption path now has two explicit layers:

1. `speech_sync` applies to every transcript-backed speech caption. It allows a
   two-frame reading lead by default, then clamps larger cue-level lead.
2. `protect_reveals` includes `speech_sync` and additionally splits explicitly
   authored punchline/surprise/reaction/payoff anchors so the protected text begins
   one frame after its audio onset by default.

No character-count interpolation is used for a protected in-utterance anchor. If
word timing, item onset, explicit source time, or explicit timeline time cannot
resolve it, caption review blocks approval with `unresolved_reveal_anchor`.

## IMG_3921 evidence

Read-only audit inputs:

- `projects/img-3921-content/07_package/caption_approval.json`
- `projects/img-3921-content/03_analysis/transcripts/TR_AST_A043346C.json`
- `projects/img-3921-content/05_timeline/timeline.json`

At 24 fps, `speech_sync` checked 17 captions and found 9 cues beyond the two-frame
reading lead:

| Caption | Early by |
| --- | ---: |
| SC_0003 | 12 frames |
| SC_0004 | 8 frames |
| SC_0005 | 31 frames |
| SC_0006 | 10 frames |
| SC_0009 | 10 frames |
| SC_0010 | 27 frames |
| SC_0011 | 99 frames (4.125 sec) |
| SC_0016 | 8 frames |
| SC_0017 | 3 frames |

This confirms the general speech-timing failure independently of any punchline
classification. The audit did not rewrite or rerender the existing video.

## Implementation surfaces

- `runtime/caption/semantic-timing.ts`
- `runtime/commands/caption.ts`
- `runtime/caption/review-core.ts`
- `schemas/caption-timing-report.schema.json`
- caption policy contracts in blueprint, approval, and review schemas
- blueprint prompt/sanitizer defaults transcript captions to `speech_sync`
- `full-pipeline` Gate 9 and `evaluate-edit` regression instructions

## Verification

- Targeted semantic timing + short-form tests: 10 passed
- Caption/schema regression set: 44 passed
- `npx tsc --noEmit`: passed
- `npm test`: passed
- `npm run verify`: all gates passed
- `npm run eval -- --suite golden`: exited 0; fixed suite artifacts unchanged
- `npm run eval -- --all --min-score 80`: existing self-agreement failures remain
  for `fumoto-growth` and `img-3921-content`, plus an existing invalid negative trim
  in `rokutaro-bicycle-growth-20260427`; these are timeline/golden agreement findings,
  not caption semantic-timing test failures.
