# Dialogue semantic automatic repair loop

Date: 2026-07-15

## Objective

Turn the speech-led semantic completeness gate into a bounded automatic repair
loop. When a selected interview excerpt begins without its antecedent or ends
before its conclusion, the compiler should try adjacent transcript utterances,
revalidate the text after every attempt, and apply the edit only when the
result is demonstrably complete.

## Implemented behavior

- Dialogue ranges are assessed with the same deterministic Japanese semantic
  boundary rules used by `story.dialogue_completeness`.
- The compiler adds at most one adjacent utterance per side per iteration and
  reassesses after every iteration.
- The default loop is bounded to 4 iterations, 15 seconds of total extension,
  and a 2.5-second maximum inter-utterance gap.
- Neighboring speech is accepted only when the speaker labels match, whenever
  both labels are available.
- Segment bounds and the previous/next selected range from the same asset are
  hard limits.
- A repair is committed only when all targeted hard and soft findings are
  resolved. An unresolved attempt leaves the original source range unchanged
  and records reviewable metadata.
- Successful repairs ripple later video, original audio, and beat markers.
  Matching source audio receives the same source range and duration.
- Human-approved `human_golden_order` timelines are protected from automatic
  range changes.
- Final ending post-roll is now clamped before the next transcript utterance so
  the ending treatment cannot reintroduce a speech cut after semantic repair.

Each attempted clip records `metadata.dialogue_semantic_repair` with status,
attempt count, added utterances/frames, and before/after issue codes.

## Verification

### Unit and compiler integration

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run tests/compiler-continuity.test.ts tests/dialogue-semantic-repair.test.ts tests/ending-treatment.test.ts tests/cut-breath-treatment.test.ts tests/dialogue-completeness.test.ts tests/review-metrics.test.ts tests/review-metric-verdict.test.ts --reporter=default
```

Result: 7 files passed, 61 tests passed.

The integration fixture begins with only the dependent middle utterance. The
compiled V1 and original-audio ranges both become `0..6,000,000 us`, the clip
becomes 144 frames, and the compiler log reports one successful repair with no
unresolved attempt.

### Full repository regression

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run --reporter=default --silent
```

Result: 172 files passed, 4 skipped; 2,733 tests passed, 39 skipped.

### Typecheck

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsc --noEmit
```

Result: passed.

### Real interview regression: old IMG_8155 rough-cut inputs

The retained pre-dialogue-script-v2 selects and blueprint were compiled in an
isolated scratch project with the current compiler. The source project and
media were not modified.

Compiler summary:

```text
[dialogue-semantic-repair] attempted=4 repaired=4 unresolved=0 added_frames=343
```

| Clip | Original finding | Added frames | Result |
| --- | --- | ---: | --- |
| `CLP_0003` | dependent ending | 76 | resolved |
| `CLP_0006` | continuative ending | 115 | resolved |
| `CLP_0009` | dependent ending | 84 | resolved |
| `CLP_0010` | dependent opening | 68 | resolved |

Final timeline length is 9,964 frames and remains within the requested duration
policy. A fresh metrics computation returned:

- `story.dialogue_completeness`: pass, 17 clips checked, 0 hard, 0 soft.
- `audio.speech_cut`: pass, 17 clips checked, 0 violations.

The final clip's desired tail overlapped the following transcript utterance, so
ending treatment correctly recorded `clamped_before_next_speech: true` and kept
the fade inside the retained source range.

### Editorial agreement harness

- `npm run eval -- --suite golden --no-write`: exit 0. The two checkout-local
  testimonial human goldens both remain 100; fixed suite scores are
  52 / 100 / 100 / 100 / 100.
- `npm run eval -- --all --min-score 80`: all speech-led goldens remain 100 and
  `lively-alt-vol5` remains 94.2. The repository-wide command remains non-zero
  because of the existing `fumoto-growth` score of 52 and the pre-existing
  negative `src_in_us` validation failure in
  `rokutaro-bicycle-growth-20260427`.

## Residual limits

- The deterministic Japanese boundary rules are deliberately conservative;
  ambiguous subject omission still belongs in human caption/dialogue review.
- Adjacent same-source clips are currently assessed independently. A later
  refinement can group truly contiguous placements so a soft conversational
  continuation across an inaudible edit is not reported twice.
- The repair metadata is present in `timeline.json`, but Studio does not yet
  expose a dedicated repair-history panel.
