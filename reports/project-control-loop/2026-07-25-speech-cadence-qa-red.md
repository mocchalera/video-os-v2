# F-0083 waveform-grounded speech cadence review — red baseline

Date: 2026-07-25

Story: `US-0053`

Acceptance test: `TC-0149`

## Command

```text
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run tests/speech-cadence-qa.test.ts
```

## Observed red state

The suite failed before collection because
`runtime/review/speech-cadence-qa.ts` did not exist.

The missing contract is the intended failure:

- source-space `audio_events` silence is not mapped through dialogue clips to
  exact timeline ranges;
- excessive head, internal, and tail holds do not produce deterministic review
  items;
- canonical cut-breath intent is not considered;
- missing waveform evidence cannot be distinguished from a verified cadence;
- package QA and Studio have no shared speech-cadence review projection.
