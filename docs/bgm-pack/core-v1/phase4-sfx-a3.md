# Phase 4 — hash-pinned SFX and A3 execution

Phase 4 promotes short sound effects from direct timeline attachments into a
formal, rights-aware cue contract. It does not choose final sound design,
change picture timing, acquire external assets, or grant public-release
approval.

## Lane ownership

The shared audio route assigns one responsibility to each lane:

- A1 is dialogue and natural sound. Dialogue cleaning and finishing may be
  applied only to this stem.
- A2 is hash-pinned music from `music-cues/v2`.
- A3 is hash-pinned SFX from `sfx-cues/v1`.

An A3 clip is never accepted as dialogue-finishing input. `simple_sound` is a
semantic role inside the same SFX library and cue contract; it is not a
shortcut for attaching an unverified file directly to the timeline.

## Library and cue contracts

`sfx-library/v1` pins a stable library ID and version, a manifest hash, and
each asset's ID, safe relative path, SHA-256, byte size, duration, provenance,
and rights evidence. Unknown assets, missing evidence, unsafe or escaping
paths, missing files, size drift, and hash drift fail closed.

`sfx-cues/v1` pins the exact library identity and manifest hash. Every cue
contains:

- stable cue ID and semantic role;
- exact timeline range or trigger plus duration;
- exact source in/out range;
- gain and fade values;
- an explicit tail limit and deterministic tail policy;
- duck group and dialogue duck parameters;
- asset ID, content hash, byte size, and library/version pins; and
- provenance and rights evidence matching the verified library asset.

All frame-to-time conversion uses the timeline's rational frame rate. A cue may
not escape the timeline, its asset duration, or its declared tail limit.

## Projection and shared execution

`projectSfxCuesToTimeline()` projects verified cues to the A3 lane and is
idempotent by cue ID. The shared audio executor then runs one fixed order:

1. extract and place A1;
2. apply dialogue finishing to A1 only;
3. cut A2 cues, apply gain/fades, and derive music ducking from A1;
4. cut A3 cues, apply gain/fades and deterministic tail handling, and derive
   requested SFX ducking from A1;
5. mix A1, A2, and A3 in stable cue order; and
6. apply final mastering exactly once.

The executor normalizes filter inputs to a deterministic sample frame before
sidechain and mix stages. A mixed A1+A2+A3 stream is never sent back through
dialogue finishing.

## Report and conditional QA

`audio-mix-report/v2` remains backward compatible and, when SFX is enabled,
records the library/version/manifest pins, asset hashes, A3 stem hashes,
applied cue values, tail decisions, dialogue sidechain evidence, peak and
headroom evidence, and `mastering_count = 1`.

Package QA requires SFX report and pin checks only when the formal SFX artifact
sets `required: true`. It verifies cue ranges, applied values, tail handling,
dialogue overlap, peak/headroom evidence, and social/final plan, report, and
final-mix parity. No-SFX, no-BGM, `original_only`, and legacy embedded-BGM
projects retain their prior required-check set.

## CLI

Validate a library and project a cue artifact onto A3 without writing:

```bash
npm run sfx:project -- \
  --project /path/to/scratch \
  --timeline /path/to/scratch/05_timeline/timeline.json \
  --cues /path/to/scratch/07_package/sfx_cues.json \
  --dry-run
```

Write a new projected timeline by supplying `--output`. The command refuses an
existing output. Audio-only social or final execution uses the same
`render-audio-plan` CLI as Phase 3 with `--sfx-cues`; at least one of
`--music-cues` or `--sfx-cues` is required.

## Deferred boundary

Phase 5 adds semantic-first timing, bounded evidence-backed tempo decisions,
and the `short-sound-design` skill without changing this executor. See
`phase5-semantic-sound-design.md`. Human audition still owns sound character,
placement, musical interaction, and final adoption. Public release remains a
separate approval gate.
