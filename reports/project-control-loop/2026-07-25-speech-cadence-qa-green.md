# Speech Cadence QA — Green Evidence

## Scope

- Goal: G-0012
- Task: T-0052
- Feature: F-0083
- User story: US-0053
- Test case: TC-0149

## Delivered behavior

- Converts FFmpeg `silencedetect` events from source time into exact edited-timeline frame ranges.
- Preserves rational frame clocks, including `30000/1001`, and accounts for clip speed changes.
- Applies explicit social-short thresholds from the active retention profile:
  - aggressive: head/tail 350 ms, internal 600 ms
  - standard: head/tail 450 ms, internal 750 ms
  - credibility-first: head/tail 600 ms, internal 1000 ms
- Emits deterministic review items with stable IDs, clip/asset/event identity, source and timeline ranges, timecode, duration, suggested action, and remediation.
- Distinguishes `trim_in`, `jump_cut`, and `trim_out` recommendations.
- Protects intentional authored breath holds from false positives through exact `cut_breath_treatment.extended_frames` matching.
- Returns `incomplete` when waveform evidence is missing, malformed, or bound to another project; it never reports a false verified result.
- Returns `not_applicable` for non-social timelines or timelines without dialogue.
- Projects the review into package QA and macOS Studio without automatically changing the edit or creating a publication hard gate.
- Keeps the package schema backward compatible by making the new metric optional.

## Verification

- `npx vitest run tests/speech-cadence-qa.test.ts`
  - 4 passed
- `npx vitest run tests/speech-cadence-qa.test.ts tests/package-cli.test.ts`
  - 25 passed
- `npx tsc --noEmit`
  - passed
- `swift test --package-path apps/macos-studio --filter ProjectRenderPackageStatusTests`
  - 7 passed
- `swift test --package-path apps/macos-studio`
  - 601 passed, 0 failures
- `npm run verify`
  - 255 test files passed, 6 skipped
  - 3670 tests passed, 44 skipped
  - typecheck, unit tests, demo schema validation, and demo review metrics all passed
- `npm run verify:studio-contracts`
  - passed; generated contract fixture is current
- `git diff --check`
  - passed

## Acceptance evidence

1. A social-short fixture containing excessive head, internal, and tail silence produces exact deterministic review positions.
2. The same input produces byte-equivalent structured output and stable review IDs.
3. An authored breath hold matching the detected tail interval is excluded from findings.
4. Missing evidence is reported as `incomplete`; non-social work is `not_applicable`.
5. Package schema validation accepts the metric, and Studio decodes and presents actionable items.
6. Timeline input remains unchanged by the detector.

## Boundary and residual risk

- This is an advisory review layer. It does not auto-apply jump cuts and does not block package or publication.
- `audio_events.json` project identity is validated, but a dedicated source-hash freshness binding remains a future hardening item.
- No source media, rendered media, publication, upload, or external message was created or changed.
