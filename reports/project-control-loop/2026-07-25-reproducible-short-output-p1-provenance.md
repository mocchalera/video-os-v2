# Reproducible short output P1 — provenance

Date: 2026-07-25
Task: T-0052
Feature: F-0080
Story: US-0050
Tests: TC-0144, TC-0145, TC-0146

## Outcome

New short-form packages carry one `derived-video-provenance/v1` artifact that
binds source identity and technical metadata through the exact final video.
Known generated videos cannot enter the render/package path as sources unless a
hash-bound `clean-base-attestation/v1` proves a full-duration human review by a
verifier independent from the producer.

## Contracts

- `runtime/render/clean-source-policy.ts`
  - detects repository-managed render/output lanes;
  - validates subject, receipt, and evidence hashes;
  - rejects same-identity producer/verifier claims;
  - runs from source-input attestation before package media writes.
- `runtime/packaging/derived-video-provenance.ts`
  - records source content hashes, duration, dimensions, and audio layout;
  - binds source-input aggregate, timeline, caption approval, render route or
    NLE handoff, and final output;
  - rebuilds the artifact against live files for tamper detection.
- package manifest `1.1.0`
  - references the derived provenance artifact by SHA-256;
  - remains additive-compatible with existing package manifests.

## Verification

Repository Node:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npx tsc --noEmit
```

Targeted contracts:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npx vitest run \
  tests/derived-video-provenance.test.ts \
  tests/source-input-attestation.test.ts \
  tests/source-map.test.ts
```

Package integration was also run with test-only `ffmpeg`/`ffprobe` version and
filter shims because the machine's Homebrew binaries cannot currently start:

```sh
PATH=/tmp/video-os-p1-bin:/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run tests/package-assembler.test.ts
```

The shims were outside the repository and were not used for media generation or
media-content assertions.

Result: 41/41 targeted tests passed, TypeScript typecheck passed, and
`git diff --check` passed.

## Remaining P1 work

- expand timeline-derived detector intent coverage;
- add deterministic caption/CTA bounding-box, glyph clipping, duplicate-body,
  collision, and end-card checks;
- rerun media-backed package/render verification after the local
  FFmpeg/Harfbuzz installation is repaired.
