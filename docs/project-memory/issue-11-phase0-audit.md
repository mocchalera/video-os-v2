# Issue #11 — Phase 0 measurement-first audit

- audited exact base: `372b26891a6ef833121fd35ad688eb428cfd8715`
- audit date: 2026-08-25
- canonical Day2 was read-only: `/Users/operator/Dev/video-os-v2-spec/projects/narunaru-day2-yamanakako-jog`
- all experiments and generated evidence live outside the canonical project and direct worktree.

## Policy scope

At this exact base, the old creator-short guidance `26–38 cuts/min` and a universal
`2.5 seconds` same-composition ceiling are no longer present in
`.agents/skills/finish-creator-short/SKILL.md` or its required reference. Commit
`f5b37d59` (an ancestor of the audited base) replaced fixed generic pacing
numbers with project-contained retention/composition policy and measured review
evidence. Therefore these two old numbers have no runtime or current Skill scope
to conflict with Day2.

`runtime/editorial/arcs/vlog-day-log.yaml` still marks `setup_purpose.tempo:
slow`. The Skill and required reference explicitly define `tempo` as planner
guidance, not a compiler field or runtime gate. No machine-enforced conflict
exists.

A distinct runtime duration input remains:
`edit_blueprint.yaml.pacing.max_shot_length_frames` (falling back to
`trim_policy.default_max_duration_frames`) is consumed by
`runtime/compiler/index.ts::buildUtteranceSnapMaxDurations`. It is blueprint
wide, not mode/role scoped. It is only a Phase 2.5 candidate if a successful A1
assembly measurement attributes actual loss to this input.

## Base inventory

| State | Capability / evidence |
| --- | --- |
| Implemented and publicly wired | creator-short kickoff detection and pre-kickoff B-roll suppression: `creator-short-vo-broll.ts` -> compiler -> assembler |
| Implemented and publicly wired | vlog narrative-arc registry and normalized arc contract |
| Implemented and publicly wired | footage DB builder through `build-footage-db.ts` and full-pipeline footageDb phase |
| Day2 executed | partial analysis artifacts, human-fixed plan, and a historical compile (`progress.json` says compile/completed) |
| Day2 not executed | current exact-base auto assembly; current kickoff preset (human exact plan disables it, and Day2 is `dominant_visual_mode: mixed`) |
| Missing Day2 artifact | `03_analysis/search/footage.db` |
| Missing Day2 artifact | `audio_story_graph.json`, `continuity_graph.json` |
| Base not implemented | assembly-loss evaluator (implemented by this task in Phase 2) |

The canonical timeline contains 75 textual `human_golden_order` provenance
references and no canonical `provenance.creator_short_vo_broll` entry. File
presence is not treated as proof that the current auto route ran.

## Day2 analysis and coverage

Direct inventory at audit time:

- 405 files under `03_analysis`
- `assets.json`, `segments.json`, `marlin_events.json`,
  `source_ledger.json`, `cache_manifest.json`, `gap_report.yaml`, and
  `analysis_coverage_report.json` exist
- 13 transcripts, 13 filmstrips, 13 posters, 26 contact-sheet files,
  13 waveforms, 26 appraiser-frame files, and 293 VLM-frame files exist
- analysis coverage is `summary.status=blocked` (2 ready lanes, 10 pending,
  4 skipped)
- selects coverage is `status=failed`
- `footage.db`, `audio_story_graph.json`, and `continuity_graph.json`
  do not exist

This is a grounding-failure state. Any retained diagnostic is marked HOLD and
must not be interpreted as auto-assembly capability success or failure.

## footage-db incremental option

`scripts/build-footage-db.ts` accepts and forwards `--rebuild-mode`, and the
option exists in `BuildFootageDbOptions`. The public `buildFootageDb`
implementation never reads `options.rebuildMode`; the full-pipeline executor
also does not pass it. Both values therefore take the same rebuild path.
`incremental` is not performance evidence.

## Phase 3 gate fixed before results

Owner: operator/user. An agent may report evidence but may not enter Phase 3.

All five conditions are mandatory:

1. a hash-pinned loss report contains important unexplained loss;
2. an operator record declares that loss mandatory to repair;
3. evidence shows a minor trim cannot repair it and structural change is needed;
4. coverage/grounding failure cannot explain it;
5. this owner/evidence procedure is followed.

Only after all five conditions may a separate task first add a no-write/in-memory
compile path and consider at most two proposals. No all-pairs search, new
canonical graph/table/schema, provider dependency, ranking, or preference
read-back is authorized here.

## Unverified

Transcript generation provenance, completeness semantics of derivative frame
sets, a cold source-to-reviewable-preview wall clock, and optional-model
fail-open inside an actual A1 compile remain unmeasured. Existing targeted tests
are reported separately and are not substituted for those runtime observations.
