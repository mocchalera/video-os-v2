# Interview MA and reframe finishing path

Date: 2026-07-15

## Objective

Remove the one-off FFmpeg work required to finish a speech-led interview. The
canonical review patch and shared assembler should be able to apply a
repeatable dialogue MA preset, enlarge and reposition the speaker, preserve
authored frame duration for VFR phone footage, and leave caption or section-card
overlays untouched.

## Friction found

- The shared renderer already understood per-clip `zoom`, `crop`, and
  `position`, but review patches could not author those values.
- A two-pass EBU R128 loudness helper existed, but the assembler exposed only a
  single-pass loudness filter and no dialogue-cleaning preset.
- Manual finishing required a custom filter graph so captions and question
  cards were not scaled with the interview image.
- The first VFR source segment in the IMG_8155 interview encoded three frames
  shorter than its authored timeline duration, creating an accumulated A/V tail
  mismatch.
- No single skill described the measure -> patch -> clean assembly -> overlay ->
  QA workflow.

## Implemented behavior

- Review patches now support `change_visual_transform` with zoom, crop, and
  pixel position, and `change_audio_finish` with a versioned MA policy.
- The shared assembler accepts `dialogue-clean`, `loudness-only`, or `none`.
  `dialogue-clean` applies high/low-pass filtering, conservative broadband noise
  reduction, mud/presence EQ, dialogue compression, and measured two-pass
  loudness normalization. Defaults target -16 LUFS and -1.5 dBTP, with codec
  headroom before AAC encoding.
- Existing one-pass A1 normalization is bypassed when the final MA policy is
  active, preventing double normalization.
- Every rendered VFR segment is padded or trimmed to its authored frame
  duration before concatenation. The final mux is also bounded by the authored
  timeline duration.
- Visual transforms remain inside clean video-segment rendering, so downstream
  captions, lower thirds, and section cards keep their designed size.
- `.agents/skills/finish-interview` records the repeatable workflow, parameter
  guidance, patch example, and QA contract. `re-edit` routes MA and reframing
  requests to this finishing path.

## Verification

### Unit and assembler integration

The new coverage verifies filter composition, measured pass-two construction,
review-patch application and rejection, custom final mux filtering, and
authored-duration normalization for VFR inputs.

### Full repository regression

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run --reporter=default --silent
```

Result: 173 files passed, 4 skipped; 2,740 tests passed, 39 skipped.

The first run exposed a local native-module ABI mismatch because
`better-sqlite3` had been built by Node 25. `npm rebuild better-sqlite3` under
the repository's Node 22 runtime repaired the environment without changing the
dependency version.

### Typecheck and skill validation

- `npx tsc --noEmit`: passed.
- `quick_validate.py .agents/skills/finish-interview`: passed.

### Real IMG_8155 interview scratch render

The source project and media were not modified. A 1,018-frame excerpt was
copied into `/tmp`, patched with `zoom: 1.15`, `position: {x: -144, y: -39}` and
the `dialogue-clean` preset, then rendered through the shared assembler.

| Check | Result |
| --- | --- |
| Authored duration | 1,018 frames at 24 fps |
| Encoded video | 1,018 frames / 42.416667 s |
| Encoded audio | 42.416000 s |
| A/V end delta | 0.000667 s |
| Integrated loudness | -15.80 LUFS |
| True peak | -1.77 dBTP |
| Reframe | speaker enlarged; headroom and look-room retained |

The excerpt begins with a three-second silent question-card gap, so its measured
16.3 LU LRA is not representative of the full interview. Integrated loudness,
true peak, authored frame count, and A/V delta are the relevant acceptance
signals for this short proof.

### Editorial agreement harness

- `npm run eval -- --suite golden --no-write`: exit 0. The two AX-1 human
  goldens and the other speech-led fixed targets remain 100. Fixed suite scores
  are 52 / 100 / 100 / 100 / 100.
- `npm run eval -- --all --min-score 80`: the finishing changes introduce no
  new editorial drift. The repository-wide command remains non-zero because of
  the existing `fumoto-growth` score of 52 and the pre-existing negative
  `src_in_us` validation error in `rokutaro-bicycle-growth-20260427`.

## Residual limits and next tools

- Studio does not yet expose the MA preset or zoom/position controls. The new
  patch operations are the contract for that UI.
- Reframe values are still selected by visual inspection. Face/eye detection
  plus gesture-aware safe bounds would make automatic reframing more robust.
- Static interview framing is supported; moving subjects still need optional
  keyframed tracking with smoothing and a maximum pan velocity.
- Question cards and captions are protected by render order, but a canonical
  overlay-track model would make the ordering constraint easier to inspect and
  validate in Studio.
- A full-program loudness report should be generated after captions/cards are
  burned and before final approval; the scratch excerpt is an implementation
  proof, not the final AX-1 master.
