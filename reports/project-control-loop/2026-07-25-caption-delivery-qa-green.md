# Caption Delivery QA — Green Evidence

## Scope

- Goal: G-0012
- Task: T-0052
- Feature: F-0084
- User story: US-0054
- Test case: TC-0150

## Delivered behavior

- Compares the exact approved social-caption cue text and ranges with matching
  `caption_review_preview.json` word-timing evidence.
- Requires matching project identity, approved status, approved draft hash,
  caption identity, text, asset/segment identity, and cue range before using
  timing evidence.
- Maps source word ranges to exact edited-timeline frames, including rational
  frame rates and speed-adjusted clip spans.
- Emits deterministic review items with stable IDs, caption text, audio/caption
  bounds, exact timeline range, millisecond timecodes, measured value,
  threshold, suggested action, and Japanese remediation for:
  - caption appearing before its spoken phrase;
  - caption appearing noticeably after its spoken phrase;
  - caption disappearing before the final referenced word;
  - caption dwell/CPS providing insufficient read time.
- Preserves explicitly authored protected reveal timing and reports how many
  protected reveals were evaluated.
- Reports `incomplete` instead of false verification when preview evidence,
  word ranges, identity, approved draft hash, or clip mapping is missing or
  stale.
- Returns `not_applicable` for non-social work or work without approved speech
  captions.
- Projects the result into package QA and macOS Studio. Studio presents the
  exact time range, affected text, measurement, threshold, action, and remedy.
- Remains advisory: it does not rewrite captions, auto-apply timing changes, or
  create a package/publication hard gate.

## Acceptance evidence

The media-independent fixture contains:

1. an early cue;
2. a late cue;
3. a cue ending before the final spoken word;
4. the short strong phrase `馬鹿げてますよね`;
5. an intentional protected reveal;
6. missing and mismatched evidence;
7. a non-social control.

Repeated evaluation produces identical structured output and stable issue IDs.
The timeline, approval, and preview inputs remain unchanged.

## Verification

- Node runtime: repository-pinned Node.js `22.23.1`
- `npx vitest run tests/caption-delivery-qa.test.ts`
  - 4 passed
- `npx vitest run tests/caption-delivery-qa.test.ts tests/speech-cadence-qa.test.ts tests/package-cli.test.ts`
  - 29 passed
- `npx tsc --noEmit`
  - passed
- `swift test --package-path apps/macos-studio --filter ProjectRenderPackageStatusTests`
  - 8 passed
- `swift test --package-path apps/macos-studio`
  - 602 passed, 0 failures
- `npm run verify`
  - typecheck, unit tests, demo schema validation, and demo review metrics all passed
- `npm run verify:studio-contracts`
  - passed; generated contract fixture is current
- `git diff --check`
  - passed

The first package regression attempt intentionally failed because the ambient
shell exposed unsupported Node.js 24. The identical command passed under the
repository-pinned Node.js 22 runtime; this validates that the shared media-write
doctor is enforcing the declared environment contract.

## Boundary and residual risk

- The detector uses approval-bound review-preview word timing. It does not
  substitute visual OCR or a second final-audio transcription pass.
- Thresholds remain review policy. Promotion to a hard gate still requires
  false-positive benchmarking across social-talking-head genres.
- No source media, rendered media, publication, upload, or external message was
  created or changed.
