# Longform Event Mode

`longform-event` is the deterministic reduction mode for fixed-camera event footage. It keeps the event in source chronology, removes low-value intervals, and produces an inspectable timeline close to the requested long runtime.

The mode uses the same canonical artifacts and compile/render path as other profiles:

```text
transcripts -> selects_candidates.yaml -> edit_blueprint.yaml -> timeline.json -> render -> QA
```

The profile also enables transcript captions for both burn-in and SRT/VTT
sidecars. Caption generation stays artifact-first: it reuses the existing
transcripts, splits long ASR items into at most 30 Japanese characters (up to
two 20-character lines), drops sub-400ms edge fragments, and uses the restrained
`longform-event` lower-third preset. This avoids running speech recognition a
second time; the expensive step is only the final full-duration video encode
needed for burn-in. Use the sidecar output alone when a platform/player can
display subtitles and avoiding that encode matters more than fixed styling.
For names and brand spellings, add `01_intent/caption_glossary.yaml`; see
[`caption-glossary.md`](caption-glossary.md). The caption command applies its
project-local corrections before splitting and also protects canonical terms
during optional LLM editorial.

Adjacent captions keep a one-frame blank interval, so the outgoing and
incoming subtitles cannot briefly render as a stacked pair. Dialogue cuts can
also retain source post-roll through `dialogue_policy.cut_tail_hold_sec`. The
long-form preset keeps 0.35 seconds and ripples the remaining timeline. If that
handle reaches the next utterance, only the intruding tail is faded using
`cut_audio_fade_out_sec` (0.2 seconds in this preset).

## Enable the mode

Set the following fields in `01_intent/creative_brief.yaml` before running `npm run full-pipeline` or `scripts/editorial-pipeline.ts`:

```yaml
project:
  runtime_target_sec: 3600
  duration_mode: strict
order_policy: chronological
audio_policy: original_only
editorial:
  distribution_channel: event_recap
  aspect_ratio: "16:9"
  profile_hint: longform-event
  policy_hint: longform-documentary
  allow_inference: false
autonomy:
  mode: full
  may_decide:
    - transcript reduction
    - chapter allocation
  must_ask: []
  skip_confirmations: true
longform:
  mode: reduction
  source_selection: auto_primary_lane
  min_window_sec: 6
  max_window_sec: 45
  silence_gap_cut_sec: 3
  chapter_max_sec: 720
  coverage_interval_sec: 240
```

Use `source_selection: explicit` with `primary_asset_ids` when camera-lane detection is ambiguous. `auto_primary_lane` excludes another filename lane only when its duration is comparable and its normalized transcript substantially overlaps the retained lane; otherwise it keeps every source. Use `all` to disable alternate-lane inference explicitly.

## Planning behavior

The planner:

1. loads timestamped transcript items from `03_analysis/transcripts/*.json`;
2. selects a primary chronological camera lane;
3. removes filler-only, housekeeping, duplicate, invalid, and long-silence material;
4. creates utterance-bounded windows and chronological chapters;
5. allocates the target duration across every chapter and protects interval coverage;
6. emits one exact-trim candidate and one beat per retained window;
7. fails before compile when chapter coverage is missing or selected duration falls outside 85–115% of the target.

`selects_candidates.yaml.longform_plan` and `edit_blueprint.yaml.longform_plan` record selected/excluded assets, source/speech/selected duration, keep ratio, chapters, retained references, and exclusions with reason codes. This makes automatic cuts auditable without a hidden decision store.

The normal short `event-recap` profile is unchanged. It remains a roughly 60-second highlight route; long-form reduction is enabled only by the explicit `profile_hint: longform-event` contract so an ordinary recap request cannot silently become an hour-long edit.

The profile also chooses a longer ending tail by default, but ending treatment itself is shared by every editing mode. See [`ending-treatment.md`](ending-treatment.md).

## Current boundary

The implemented gate is transcript-first. It is suitable for talks, presentations, interviews, and fixed-camera event records where spoken content defines the experience. Visual-only dead time inside an otherwise valid utterance, multicamera angle switching, applause/music-only editorial judgment, and chapter-sampled visual QA remain follow-up work. Optional local models remain fail-open, but missing usable transcripts is a hard failure for this mode.
