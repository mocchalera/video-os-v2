# Phase 3 — shared audio render plan

Phase 3 makes `music_cues.json` v2 an executable, hash-pinned audio contract.
It does not approve the selected track, alter picture timing, render SFX, or
grant public-release clearance.

## Shared contract

`resolveSharedAudioRenderPlan()` recognizes only an enabled
`music-cues/v2` projection. It resolves and verifies the Pack before a media
write, then produces a target-independent `audio-render-plan/v1` identity with:

- project, timeline hash, timeline version, and rational FPS;
- ordered A1 source clips with source hash, range, placement, role, and gain;
- ordered A2 cues with Pack/manifest/audio/analysis pins;
- exact source and timeline ranges plus cue gain, fades, duck target,
  attack, and release;
- dialogue finishing scope and a single post-mix mastering policy; and
- stable expected artifact names.

The social-review and final routes do not occur in the plan hash. Given the
same pinned inputs, both routes must resolve the same plan identity.

## Execution order

The shared executor has one order:

1. extract and place the A1 dialogue/nat stem;
2. apply optional dialogue finishing to A1 only;
3. cut each A2 source range and apply its authored base gain and fades;
4. derive sidechain attenuation from the finished A1 waveform using the cue's
   duck target, attack, and release;
5. mix A1 with the ordered A2 cue stems; and
6. apply final mastering once.

A mixed A1+A2 stream is never accepted as the dialogue-finishing input.
Picture assembly is video-only for pinned A2 cues. Direct assembly with such a
cue and embedded audio fails closed.

## Evidence and QA

`audio-mix-report/v2` binds the plan hash to input/output hashes, A1/A2 stems,
applied cue values and pins, dialogue finishing scope, waveform-sidechain
evidence, deterministic stage/input order, loudness measurements, warnings,
and `mastering_count`.

For enabled `music-cues/v2`, package QA requires:

- a v2 report with the exact cue ranges, gain/fade/duck values, and Pack pins;
- no dialogue finishing on any A2 stem;
- waveform-sidechain evidence and `mastering_count = 1`; and
- matching social-review and final plan hashes and cue contracts.

These new requirements are not imposed on no-BGM, `original_only`, or legacy
embedded-BGM projects.

## Audio-only internal audition

The following command writes audio and reports only to a new directory. It
refuses an existing output; `--dry-run` writes nothing.

```bash
npm run render-audio-plan -- \
  --project /path/to/scratch-project \
  --timeline /path/to/scratch-project/05_timeline/timeline.json \
  --music-cues /path/to/scratch-project/07_package/music_cues.json \
  --route social-review \
  --output /path/to/worktree/tmp/phase3-social-audio
```

Run the same plan with `--route final` to prove route parity. These files are
internal audition/test artifacts, not a final music choice or release approval.

## Deferred boundary

Phase 4 adds the formal SFX library, `sfx-cues/v1`, and A3 execution described
in `phase4-sfx-a3.md`. Phase 5 still owns the semantic-first tempo solver and
`short-sound-design` skill integration; those responsibilities are not
implemented or inferred here.
