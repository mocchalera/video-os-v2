# Reproducible short-output P1: deterministic caption and CTA layout QA

Date: 2026-07-25

Project Loop:

- Task: `T-0052`
- Goal: `G-0012`
- Feature: `F-0081`
- Acceptance test: `TC-0147`

## Outcome

The engine-render packaging lane now derives a deterministic layout snapshot from
canonical timeline and caption artifacts, evaluates it fail-closed, and binds the
snapshot into package manifest `1.2.0` by path and SHA-256. The NLE lane remains
manifest `1.1.0` and does not claim renderer-derived layout evidence.

No source footage, project media, rendered deliverables, publication state, or
external destination was modified.

## Implemented contract

- Caption and CTA bounds are checked against frame bounds and configured safe
  areas.
- Glyph clipping, font fallback, and missing glyphs fail with stable issue
  codes.
- More than one active speech-caption layer fails.
- Caption/CTA visual collisions fail.
- Invalid end-card holds and unknown/invalid final-frame states fail.
- Font glyph coverage is read from bundled TTF/OTF `cmap` tables without a new
  dependency.
- Package QA records the deterministic result and snapshot artifact.
- Manifest `1.2.0` binds the layout snapshot; missing, mismatched, or tampered
  snapshots block verification.
- Engine-render packages cannot claim captions when caption approval is absent.

Stable failure codes:

`renderer_evidence_incomplete`, `caption_outside_safe_area`,
`glyph_clipped`, `font_fallback`, `missing_glyph`,
`duplicate_speech_caption_layer`, `caption_visual_collision`,
`end_card_hold_invalid`, `final_frame_state_invalid`.

## Regression coverage

`tests/deterministic-layout-qa.test.ts` and
`tests/fixtures/layout-qa/cases.json` cover a compliant vertical short and the
AX-1-derived failure classes:

- safe-area escape
- frame clipping
- font fallback and missing Japanese glyphs
- duplicate speech-caption layers
- caption/CTA collision
- invalid end-card hold
- invalid final-frame state
- incomplete renderer evidence

Package tests additionally prove that the manifest hash-binds the layout
snapshot and that post-package tampering blocks verification.

## Real-media smoke validation

Homebrew FFmpeg:

- Version: `8.1.2`
- Build includes: `libharfbuzz`, `libfontconfig`, `libfreetype`, `libass`
- Filters detected: `ass`, `subtitles`

A disposable synthetic vertical render was generated with the exact bundled
`VideoOSNotoSansJPBold.ttf`:

- H.264 video plus AAC audio
- `1080x1920`
- `30/1` fps
- `4.000000` seconds
- burned-in Japanese text rendered without missing-glyph boxes
- extracted frame visually checked for one caption layer and visible glyphs

The deterministic output scan returned:

```text
status=verified
scanned_duration_sec=4
issues=[]
```

The disposable media and extracted frame were kept outside the repository and
removed after validation.

## Verification

Runtime: Node.js `22.23.1`

```text
npm run verify
  typecheck: passed
  unit-tests: passed
  schema-validation (demo): passed
  review-metrics (demo): passed

Test Files  248 passed | 6 skipped (254)
Tests       3665 passed | 44 skipped (3709)

npm run verify:studio-contracts
  passed

git diff --check
  passed
```

The canonical macOS Studio contract fixture was regenerated with
`npm run generate:studio-contracts` and verified.

## Remaining scope

This completes the P1 deterministic caption/CTA layout QA feature, not the
overall `T-0052` goal. Remaining P1/P2 work includes expanding detector intent
coverage beyond the present stable failure classes and improving the review UX
that presents these machine-verifiable failures to editors. `T-0052` and
`G-0012` therefore remain open.
