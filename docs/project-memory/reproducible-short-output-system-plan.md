# Reproducible short-output system plan

Date: 2026-07-24
Scope: repository-wide contracts in `video-os-v2-spec`, not AX-1-specific edit instructions

## Outcome

Produce short-form outputs that are repeatable across projects while preserving
editorial range. The system must fail before destructive/expensive media writes,
validate the exact final captions and final rendered file, and distinguish an
implementation defect from an explicitly authored visual effect.

## Design rules

1. Canonical artifacts remain the source of truth.
2. TypeScript owns approval and publication eligibility. GAS or another remote
   adapter may transport an already approved artifact, but may not recreate the
   eligibility decision.
3. Structural safety is non-waivable. Artistic thresholds remain reviewable.
4. Detector output cannot waive itself. An exception must be derived from
   canonical authoring intent or supplied with a concrete reason.
5. Existing published/package receipts are not silently reinterpreted. New
   generation and package flows adopt the stricter contracts first.

## P0 — shared reproducibility foundation

Status: implemented in this milestone.

### Media-write doctor

One shared gate checks:

- Node.js 22.x;
- whether `ffmpeg` and `ffprobe` actually start, not only whether a path exists;
- `subtitles` and `ass` filters when caption burn-in is requested;
- output and scratch reservations grouped by filesystem device.

The assembler, exact preview renderer, and final render pipeline call the gate
after canonical input validation and before temp/output directory creation.
Capacity is estimated from expected duration rather than a fixed short-video
ceiling.

### Final caption invariants

The persisted caption order is:

1. word timing;
2. semantic timing;
3. one-frame separation;
4. dwell/CPS metric recomputation;
5. final invariant validation.

Non-waivable:

- positive duration and non-overlap;
- 300 ms hard dwell floor;
- persisted metrics equal final timing/text;
- no unresolved protected reveal;
- protected text does not precede `anchor_frame + audio_first_frames`.

Reviewable:

- 300–800 ms impact captions;
- style-specific CPS and line-length findings.

The checks run again at caption approval and packaging so an old or manually
edited draft cannot bypass them.

### Deterministic full-output QA

The actual final video is scanned to completion:

- `ffprobe` establishes duration, frame rate, and dimensions;
- `ffmpeg -xerror` decodes video and optional audio;
- progress must reach the probed duration within one frame;
- black regions, frozen regions, four-sided insets, dimension drift, and decode
  errors are recorded;
- missing, failed, or partial scans are never approval-grade.

Reasoned exceptions are derived only from canonical intent:

- timeline still-image holds allow their freeze interval;
- contain-fit still images allow their inset interval;
- authored `freeze_hold` transitions allow their freeze interval;
- authored full-frame CTA cards allow their freeze interval;
- authored fade-to-black transitions and ending policy allow their black
  interval.

An unlabeled talking-head clip derives no exception. This is the key guardrail
that preserves strong SNS treatments without normalizing accidental frames.

### Lightweight regression set

The P0 suite includes synthetic detector logs for:

- clean full-frame output;
- a 0.55 s four-sided black inset;
- an 0.8 s freeze;
- a scan that reports success after decoding only 1 s of a 30 s file;
- intentional still/freeze/fade ranges;
- captions that become shorter after semantic splitting and separation.

These fixtures contain no source media and are safe to keep in the repository.

## P1 — provenance and visual-layout contracts

Status: provenance slice implemented; detector-intent and visual-layout slices
remain.

### `derived-video-provenance/v1`

Bind every deliverable to:

- clean source or verified subtitle-free proxy identity;
- source hash, duration, dimensions, and audio layout;
- transformation chain and timeline hash;
- caption approval hash;
- final output hash.

The contract must reject a rendered/burned-caption output as a new source unless
an explicit, independently verified clean-base attestation exists.

Implemented contract:

- `derived-video-provenance/v1` binds the live source-input aggregate, every
  source content hash and technical profile, the canonical timeline, render
  route or NLE handoff, caption approval, and final video hash;
- `clean-base-attestation/v1` requires a full-duration human visual review,
  different producer/verifier identities, and hash-bound review evidence;
- paths in repository-managed render/output lanes are treated as generated
  media even if an entry is mislabeled `original_source`;
- source provenance is checked before package output directories or media
  writes are created;
- new package manifests are `1.1.0` and include the hash-bound provenance
  artifact, while older manifests retain additive read compatibility;
- package verification rebuilds the provenance from live artifacts and fails
  if the source, attestation, evidence, timeline, caption approval, render
  route, or final output changed.

Legacy inputs without complete technical ingest metadata remain explicitly
`live_only`; they are not silently promoted to verified provenance.

### Timeline-derived detector intent

Extend the current intent derivation to every other supported authored freeze,
full-screen color treatment, and transition. Require a reason and exact
frame range in the canonical artifact. Keep manual exceptions visible in QA
receipts.

### Caption and CTA layout QA

Add deterministic checks for:

- active caption bounding box versus safe area;
- glyph clipping and missing-font fallback;
- more than one subtitle-body layer;
- CTA/title collision with the caption region;
- end-card minimum/maximum hold and final-frame expression.

Use generated frame fixtures and renderer snapshots before adding expensive
real-media fixtures.

## P2 — publication and quality loop

### Publication migration

- Keep publication preflight and duplicate prevention in TypeScript.
- Bind destination, privacy, final artifact hash, and human approval in one
  immutable receipt.
- Default YouTube to `unlisted`.
- Use GAS only as the transport adapter for a hash-bound approved request.
- Keep Slack sharing a separate explicit external action.

### Product-level benchmark

Track false-hard-fail and miss rates by genre:

- social talking head;
- vertical montage;
- static CTA/end card;
- long-form lecture/interview.

Promote a new detector from shadow to hard gate only when its intentional-effect
false-positive rate is acceptable and its exceptions are canonically
representable.

### Feedback capture

Convert human review corrections into small, media-independent regression
fixtures:

- cut timing and silence-window decisions;
- semantic caption reveal timing;
- line breaks and dwell;
- end-state treatment;
- visual anomaly signature.

Do not encode project names, one speaker's face, or one campaign's copy as a
runtime special case.

## Acceptance commands

Run with the repository-pinned Node.js 22 toolchain:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npx tsc --noEmit
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npx vitest run \
  tests/media-write-doctor.test.ts \
  tests/deterministic-output-qa.test.ts \
  tests/caption-final-invariants.test.ts \
  tests/caption-narrative-improvement.test.ts \
  tests/m4-qa.test.ts \
  tests/still-image-render-guards.test.ts
git diff --check
```

Full media-backed verification additionally requires a working local
`ffmpeg`/`ffprobe` installation with libass caption filters.

## Current external blocker

The installed Homebrew FFmpeg 8.0.1 and ffprobe binaries exist but cannot start
because `libharfbuzz.0.dylib` is missing. The new doctor reports this before
media writes. Unit and contract verification use injected runners and remain
valid; full render/package verification must be rerun after the local FFmpeg
installation is repaired.
