# Phase 2 — explicit selection to A2

Phase 2 connects a Registry-verified candidate Pack to the compiler without
turning a ranked suggestion into a final music decision. A human or fixture
must name the exact `track_id`. The generated artifacts remain audition/test
evidence; they do not approve the composition, rights for public release, or a
final mix.

## Authority flow

```text
verified Pack Registry
        +
explicit track_id
        |
        v
04_plan/bgm_selection.json (operator_locked + Pack/audio/analysis pins)
        |
        v
07_package/music_cues.json (v2 source/timeline/anchor decision)
        |
        v
compiler -> 05_timeline/timeline.json A2 music clip
        |
        v
07_package/bgm-cue-decision-report.json (audition_only)
```

The selection is accepted only when the explicit track is already a ranked
candidate and resolves to exactly one verified Pack track. Pack ID/version,
Registry canonical manifest hash, full-mix hash and byte size, and canonical
analysis hash and byte size are pinned. Missing, unverified, ambiguous, or
drifted inputs fail closed.

## `music-cues/v2`

Version `2.0.0` is additive: the v1 reader and schema remain valid. V2 records:

- `selection_ref` and its deterministic JSON content hash;
- rational timeline FPS as numerator and denominator;
- Pack, full-mix, and analysis identity on `music_asset`;
- stable `cue_id`, exact source and timeline ranges, section, and phase;
- semantic anchor frame and source onset;
- beat-alignment status, confidence, grid source, warnings, and an explicit
  statement that picture boundaries were not moved.

The source duration must exactly match the timeline duration under rational FPS.
Phase 2 does not time-stretch, loop, choose endings, or move picture boundaries.
Multiple A2 cues must be unique, ordered, non-overlapping, inside the timeline
tail, and inside the verified source duration. Re-projecting the same cue is
idempotent.

Degraded analysis remains degraded. When a trusted beat grid is unavailable,
the explicit source onset is retained, `grid_source` is `null`, confidence is
not promoted, and warnings stay in the cue and decision report.

## CLI

The command writes only to a caller-selected new generation directory. Dry-run
performs Registry resolution, validation, cue planning, and in-memory A2
projection without writing. Existing output, project overlap, `.git`, and
`node_modules` targets are rejected.

```bash
npm run bgm:plan-cues -- \
  --project projects/<id> \
  --timeline /scratch/timeline.json \
  --pack-root /private/video-os/packs \
  --track-id trust-clarity-low-01 \
  --timeline-range 72:600 \
  --source-window-us 3000000:25000000 \
  --anchor-frame 72 \
  --source-onset-us 3000000 \
  --anchor-label "first grounded assertion" \
  --section opening \
  --phase dialogue-bed \
  --operator-ref "human:<review-ref>" \
  --reason "Explicit audition candidate" \
  --output /scratch/new-cue-generation \
  --dry-run \
  --json
```

Remove `--dry-run` only when the output directory does not exist. The generated
tree contains:

- `04_plan/bgm_selection.json`
- `05_timeline/timeline.json`
- `07_package/music_cues.json`
- `07_package/bgm-cue-decision-report.json`

## Compiler compatibility

The compiler reads `07_package/music_cues.json` only when present. V2 verifies
the raw `bgm_selection.json` content hash and all selection pins before
projecting A2. A missing cue file is an exact no-op. Legacy cues remain readable,
and an `original_only` brief continues to suppress legacy music. A deliberately
created v2 `operator_locked` artifact represents an explicit audition override;
its report still says `audition_only`.

Phase 3 must unify social-review and final mixing, dialogue finishing, ducking
render behavior, loudness/true-peak enforcement, and preview/final parity.
Those concerns are intentionally not implemented here.
