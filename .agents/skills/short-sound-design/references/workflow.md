# Semantic-first audio workflow

## Artifact order

1. `sound-design-request/v1`
2. `sound-design-decision/v1`
3. decision-pinned `sfx-cues/v1`
4. A3-projected `timeline.json`
5. shared `audio-render-plan/v1`
6. social/final `audio-mix-report/v2`
7. internal-review MP4 and local acceptance evidence

Do not skip from raw candidates to timeline clips. Do not edit adopted cue frames or assets
after solver output; rerun the solver with changed raw evidence instead.

## Request evidence

- Pin project ID, timeline version/hash, rational FPS, duration, SFX library/version/hash,
  and each asset hash/size/rights/provenance record.
- Give each candidate a stable ID, semantic role and purpose, evidence refs, strength,
  anchor/window, formal asset pin, source range, gain/fade/tail and ducking.
- Record dialogue windows separately from caption, overlay, lower-third, section,
  music-entry and picture-edit congestion.
- Supply beat/downbeat frames only from a pinned analysis artifact. A BPM number alone is
  not a grid. Mark missing, empty, low-confidence or degraded evidence honestly.

## Solver interpretation

- Treat semantic purpose and evidence as hard prerequisites.
- Reject excessive congestion before applying density and spacing limits.
- Rank equal scores by stable candidate ID.
- Keep snapping within the configured maximum of three frames and within the semantic
  window. Never cross picture-edit or dialogue boundaries.
- Treat `snap.applied=false` as a complete decision when beat evidence is unusable or
  moving the cue would weaken meaning.
- Never move picture, dialogue, caption or overlay timing.

## Review checklist

- Read every adoption and rejection reason; do not infer that an adopted technical cue is
  artistically approved.
- Confirm every adopted decision has exactly one cue with matching candidate ID,
  decision hash, resolved frame, semantic role and asset ID.
- Confirm A1 alone received dialogue finishing, A2/A3 used their pinned gain/fade/duck
  values, and final mastering ran once.
- Compare social/final plan hash, report cue contracts and final-mix hash.
- Decode the full internal review and verify duration, rational FPS, A/V boundaries,
  captions/overlays/picture identity, loudness/true peak and canonical input hashes.
- Keep audio/video outputs, SFX libraries and forward-test evidence outside Git.

## Human gates

Machine checks establish identity, rights evidence, deterministic placement and render
parity. A human still decides timbre, placement feel, BGM choice and whether the work may
be published.
