# Speech-led product regression

The speech-led product uses two separate gates so pull requests remain fast without treating media-free checks as visual proof.

## Pull-request gate

`npm run test:speech-led-contract` validates the canonical artifact contract with a synthetic, media-free project assembled from tracked fixture artifacts. It checks:

- `interview-highlight` plus the `interview` policy hint;
- disabled profile inference and editorial ordering;
- brief and compiled timeline duration in the 60–180 second product range;
- transcript/authored captions using the approved `clean-lower-third` 60px-at-1080p preset;
- operator approval, an approved/packaged state, and a source-of-truth decision;
- an approved review with no fatal issues;
- an explicit visual-QA state, without promoting a waiver to verified.

`npm run test:event-recap-contract` is the second-profile gate. It proves that
`event-recap` changes policy, cadence, trim length, novelty/hook targets, active
skills, and chronological assembly through the shared profile resolver and
compiler contracts. It does not introduce an event-specific pipeline and does
not claim real-media visual quality.

The PR `product-gate` job is the single required-check candidate. It runs the
Node runtime assertion, schema validation, speech-led and event-recap contract
checks, Studio fixture, repository hygiene, skill contracts, and build in one
Ubuntu job. The full Node suite, editor-server integration, macOS Studio, and
real render are intentionally owned by the protected-push/manual full
integration workflows; see [`docs/ci-workflow-modes.md`](ci-workflow-modes.md).

## Real-media gate

`.github/workflows/speech-led-real-media.yml` runs weekly and can also be started with `workflow_dispatch`. It requires a self-hosted macOS runner with the labels:

```text
self-hosted, macOS, video-os-media
```

The runner must have FFmpeg/FFprobe, the live Marlin model environment, and access to one rights-cleared speech-led project. Configure:

- repository variable `VIDEO_OS_SPEECH_LED_PROJECT_PATH`, or supply `project_path` when dispatching;
- optional repository variables `VOS_MARLIN_PYTHON` and `VOS_MARLIN_WORKER` when the defaults are not valid on the runner.
- Actions secret `HF_TOKEN` with access to the gated `NemoStation/Marlin-2B` model.

The workflow forces `VOS_MARLIN_MOCK=0`, renders a fresh rough cut into the runner temporary directory, runs Marlin against that exact render, and uploads JSON evidence only. The rendered MP4 remains runner-local and is not uploaded. The gate fails when:

- the artifact contract is invalid;
- the render is missing, outside 60–180 seconds, or fails duration parity;
- Marlin is unavailable, blocked, unverified, or mocked;
- the Marlin score is below the configured threshold;
- a critical Marlin issue exists;
- Marlin evaluated a different-duration render.

An operator visual-QA waiver remains valid for local human review, but it is never accepted as automated real-media regression success.
