# Dialogue semantic completeness and cut-breath regression

Date: 2026-07-15

## Objective

Promote the successful `IMG_8155.MOV` dialogue-script revision rules into the
default speech-led editing path so the first autonomous rough cut is less likely
to omit the subject, cut before the conclusion, or import the next assertion as
post-roll.

## Implemented contract

- Rough and blueprint prompts require a self-contained assertion whose subject
  or antecedent is recoverable without relying on an interviewer question card.
- ASR item edges are treated as timing evidence, not proof of semantic
  completeness.
- `story.dialogue_completeness` deterministically fails clear dependent
  openings/endings and warns on softer context-loss signals.
- A hard completeness failure is promoted into the review report as a fatal
  issue, so full-autonomy review cannot auto-approve the cut; soft findings
  remain non-blocking warnings.
- Selected transcript excerpts survive normalization into `selects_candidates`
  so blueprint and fine-cut passes can inspect the same dialogue evidence.
- Cut breathing room is clamped before the next transcript utterance. A
  shortened room-tone tail may fade out, but the next assertion is never added
  and faded after the fact.

## Verification

### Targeted regression

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run tests/unified-editorial-agent.test.ts tests/llm-blueprint-agent.test.ts tests/dialogue-completeness.test.ts tests/cut-breath-treatment.test.ts tests/review-metrics.test.ts --silent
```

Result: 5 files passed, 62 tests passed.

### Full repository regression

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run --reporter=default --silent
```

Result: 171 files passed, 4 skipped; 2,727 tests passed, 39 skipped.

### Typecheck

Command:

```text
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsc --noEmit
```

Result: passed.

### Real-media discrimination: IMG_8155 interview

The new metric was run against the retained pre-revision timeline and the
current dialogue-script-v2 timeline using the same transcript artifacts.

| Timeline | Audible clips | Hard semantic issues | Soft issues | Speech cuts |
| --- | ---: | ---: | ---: | ---: |
| `09_output/timeline-before-dialogue-script-v2.json` | 17 | 3 | 1 | 17 |
| `05_timeline/timeline.json` | 12 | 0 | 1 | 0 |

The remaining soft warning is the line ending `…聞いてくるから`. It is kept as
a review signal rather than a hard rejection because conversational Japanese
can end this way while still being understandable in sequence.

### Editorial agreement harness

- `npm run eval -- --suite golden --no-write`: exit 0. Speech-led human
  goldens scored 100; fixed suite results were 52 / 100 / 100 / 100 / 100.
- `npm run eval -- --all --min-score 80`: speech-led goldens scored 100 / 100 /
  100 and `lively-alt-vol5` scored 94.2. The command remained non-zero because
  the existing `fumoto-growth` self score is 52 and
  `rokutaro-bicycle-growth-20260427` recompilation has a pre-existing negative
  `src_in_us` schema failure.

## Residual limits

- The deterministic Japanese lint is intentionally conservative; semantic
  subject recovery still depends on the editorial model for ambiguous natural
  subject omission.
- A future increment should use hard and soft findings to trigger an automatic
  candidate-window retry before the rough cut reaches operator review. This
  increment blocks an unsafe approval but does not yet repair the source range
  by itself.
