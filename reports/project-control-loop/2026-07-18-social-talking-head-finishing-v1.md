# Social talking-head finishing profile v1

Date: 2026-07-18
Task: T-0026 / Feature F-0069 / Goal G-0008

## Outcome

Implemented a genre-bounded finishing path for short social talking-head edits:

- registered aggressive `hook-title` content and Remotion treatment
- content-aware question/reveal caption motion without moving text before speech
- implicit dialogue-first BGM ceilings for social talking-head work
- render-level cold-open and meaningful visual-refresh QA
- automatic render-route resolution for CLI, Studio, and direct API entrypoints
- caption reapproval from packaged projects and existing timeline FPS preservation
- Remotion base-assembly cache that excludes downstream speech captions and HyperFrames-owned overlays
- progress output in 10% buckets during Remotion rendering

Non-social, longform, event, cinematic, and credibility-first behavior remains outside the new aggressive hook boundary. Unknown caption styles fail QA only for `social_talking_head`.

## Verification

- `npx tsc --noEmit`: passed
- `npx tsc -p tsconfig.remotion.json --noEmit`: passed
- `swift test`: 544/544 passed
- focused implementation suite: 205/205 passed
- package and E2E regression suite: 40/40 passed
- full `npm test`: 2,890 passed, 41 skipped, 40 failed

All 40 full-suite failures share one pre-existing environment cause: the installed `better-sqlite3.node` targets `NODE_MODULE_VERSION 127`, while the required Node 22 runtime uses ABI 137. No failing test is in the changed social finishing, caption, audio, packaging, route, or Remotion paths. The native dependency was not rebuilt because `node_modules` is shared with other work.

## Workspace safety

No source footage, rendered media, generated project outputs, or eval scratch artifacts are part of the implementation milestone. Repository changes are grouped with the shared BGM, typography, HyperFrames, Studio finishing, and short-form runtime surfaces they depend on.
