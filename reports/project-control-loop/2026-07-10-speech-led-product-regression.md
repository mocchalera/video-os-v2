# T-0016 Speech-led product regression gate

Date: 2026-07-10 JST

## Outcome

The speech-led product now has two explicit regression tiers:

1. a fast, media-free pull-request artifact contract gate;
2. a scheduled or manually dispatched real-media render plus live Marlin gate.

The real-media tier is fail-closed. A visual-QA waiver, blocked/unavailable result, unverified result, mock inference, score below threshold, critical issue, missing render, out-of-range duration, or render-duration mismatch cannot pass.

## Implementation

- `runtime/eval/speech-led-product-regression.ts`
  - validates the canonical brief, blueprint, timeline, project state, and review report;
  - requires `interview-highlight`, `interview`, disabled profile inference, editorial order, 60–180 seconds, operator approval, source-of-truth decision, and the approved `clean-lower-third` speech caption style;
  - keeps media-free artifact validity separate from real visual proof;
  - requires verified, non-mock, threshold-passing Marlin evidence for real-media success.
- `scripts/speech-led-real-media-regression.ts`
  - refuses non-live Marlin before rendering;
  - renders to runner-local temporary output;
  - evaluates Marlin against that exact render;
  - writes JSON evidence and returns non-zero on any failed product check.
- `.github/workflows/ci.yml`
  - adds `speech-led-contract`;
  - adds one fail-closed `product-gate` depending on all Node, Swift, schema, editor, agent, hygiene, and speech-led boundaries.
- `.github/workflows/speech-led-real-media.yml`
  - runs weekly or with `workflow_dispatch` on a rights-cleared self-hosted media runner;
  - forces `VOS_MARLIN_MOCK=0`;
  - uploads JSON evidence only, never the rendered MP4.
- `schemas/project-state.schema.json`
  - recognizes the editor-server's existing `updated_at` compatibility timestamp so the live approved golden validates under the canonical schema.

## Verification

- Node 22 full suite: 157 files passed, 4 skipped; 2,613 tests passed, 39 skipped.
- macOS Studio SwiftPM: 520 tests passed.
- Schema contract: 87 tests passed.
- Focused speech-led contract: 17 tests passed.
- Root TypeScript typecheck: passed.
- Editor-server TypeScript typecheck: passed.
- Repository hygiene: passed.
- Workflow YAML parse: passed for both workflow files.
- `lively-alt-vol5` artifact contract: passed at 91.333 seconds with `interview-highlight`, operator approval, transcript captions, `clean-lower-third`, and explicit blocked visual-QA state.
- Mocked real-media preflight: failed before render with `live Marlin inference is required`, proving that mock configuration cannot enter the expensive/product-success path.
- Prior Studio commit `d907d8b9` CI run `29084932709`: all six responsibility jobs passed.

## Operational boundary

The private `lively-alt-vol5` media and renders remain untracked. The real-media workflow is present but was not dispatched from this implementation run because the repository must first have an online self-hosted runner labeled `video-os-media` plus `VIDEO_OS_SPEECH_LED_PROJECT_PATH`. The first live run is therefore an operational activation step, not a skipped or simulated success claim.
