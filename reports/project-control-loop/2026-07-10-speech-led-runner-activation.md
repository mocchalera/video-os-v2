# T-0017 Speech-led real-media runner activation

Date: 2026-07-10 JST

## Outcome

The repository now has a persistent, repository-scoped self-hosted macOS runner for the fail-closed speech-led real-media regression. The first accepted live run completed successfully:

- workflow run: [29094676190](https://github.com/mocchalera/video-os-v2-dev/actions/runs/29094676190)
- commit: `b71fd71827595b1d575d1fba6eff53f52dc79f08`
- runner: `mocchalera-mac-video-os-media`
- labels: `self-hosted`, `macOS`, `ARM64`, `video-os-media`
- final runner state: `online`, `busy=false`
- real-media gate: passed
- Marlin: `verified`, live inference, `mock=false`, score `100/100`
- rendered duration: `91.208333s` for a `91.333333s` timeline; parity passed with a `-0.125s` delta
- Marlin issues: 0 critical, 0 warning, 0 info

The companion CI run [29094670413](https://github.com/mocchalera/video-os-v2-dev/actions/runs/29094670413) also passed all eight jobs: `node-runtime`, `macos-studio`, `schema-contract`, `agent-definitions`, `speech-led-contract`, `repo-hygiene`, `editor-server`, and `product-gate`.

## Runner configuration

- GitHub Actions runner: `2.335.1` for Apple Silicon
- official archive SHA-256: `e1a9bc7a3661e06fa0b129d15c2064fe65dc81a431001d8958a9db1409b73769`
- install root: `/Users/mocchalera/.local/share/actions-runner/video-os-media`
- persistent LaunchAgent: `actions.runner.mocchalera-video-os-v2-dev.mocchalera-mac-video-os-media`
- repository variable `VIDEO_OS_SPEECH_LED_PROJECT_PATH` points to the private derived regression fixture
- repository variable `VOS_MARLIN_PYTHON` points to the local Marlin virtual environment
- repository secret `HF_TOKEN` is configured; its value was never printed or written to tracked files

## Rights and media boundary

The runner uses a private, local, rights-cleared derived fixture at `/Users/mocchalera/.local/share/video-os-fixtures/lively-alt-vol5-regression`. It is based on the operator-approved `lively-alt-vol5` golden render with the approved 60px captions. Canonical brief, blueprint, review, state, and remapped timeline metadata are present only in that private fixture.

No source footage, derived fixture media, or rendered MP4 was committed or uploaded. The workflow artifact contains only four JSON files:

- `artifact-contract.json`
- `render-report.json`
- `marlin-qa-lively-alt-vol5_2026-07-10T13-06-06-108Z.json`
- `real-media-gate.json`

## Diagnostic runs and fixes

Two controlled diagnostic runs were cancelled before the accepted run:

- [29093483887](https://github.com/mocchalera/video-os-v2-dev/actions/runs/29093483887): the LaunchAgent could not reliably open source media through an external-volume path, so the runner was moved to the private local derived fixture.
- [29094009940](https://github.com/mocchalera/video-os-v2-dev/actions/runs/29094009940): Marlin worker errors lost their request ID and the Node client waited for timeout; the protocol now preserves the request ID and the workflow preflights and passes `HF_TOKEN` (`92eb37c4`).

Run [29094395778](https://github.com/mocchalera/video-os-v2-dev/actions/runs/29094395778) then proved that rendering, live authenticated Marlin inference, and JSON evidence upload all worked. It failed only because generic speech terms such as `speaking` and `microphone` were treated as repeated-scene anchors, producing five false continuity warnings and a score of 60. The continuity detector now ignores those generic single-token anchors while retaining exact repeated-scene and location-return checks (`b71fd718`). The saved Marlin scenes replayed with zero continuity warnings, and the final live run scored 100 without lowering the threshold of 70.

## Verification

- focused Vitest: 25 tests passed across Marlin QA, Marlin worker protocol, and speech-led product regression
- TypeScript typecheck: passed
- repository hygiene: passed for 1,388 tracked files
- saved Marlin scene replay after the continuity fix: 0 warnings
- live workflow run `29094676190`: success
- standard CI run `29094670413`: success, all eight jobs
- GitHub runner API after completion: `online`, `busy=false`

