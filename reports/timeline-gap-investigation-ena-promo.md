# Ena promo timeline gap investigation

Date: 2026-06-19

Project: `projects/ena-promo-ai/`

## Executive summary

The 90s blueprint totals 2160 frames at 24 fps. The current timeline has 19 V1 clips with 1407 frames of visible content, i.e. 58.625s. The last clip ends at frame 1974 / 82.25s because the missing frames are left as empty timeline space rather than compacted away.

Root causes:

1. `b01_hook` is empty because `cand_x9_g0Kny8qFa` is shared by b01 and b05, and the BGM-derived `maxDurationFrames` enables reverse beat candidate reservation even though the BGM cap is not constraining the 90s sequence. b05 reserves the shared candidate; b01 then has no usable candidate.
2. The remaining gaps are created after assembly. Assembly initially fills every post-hook beat window, but `applyAdaptiveTrim()` later shrinks clip durations in place and does not retime following clips or backfill the beat.
3. Guide-mode duration recovery is a no-op, and guide-mode global fill only runs for `track_layout: multi`; this project uses `track_layout: single`.
4. The persisted blueprint does not match the stated "b03 hero / b05 texture required" premise. In the current `edit_blueprint.yaml`, only b01 requires `hero`; b03, b04, and b05 require `support`, with `texture` only preferred. Selects contain 0 hero candidates.

## Artifact facts

- Blueprint target: 2160 frames / 90.0s, from five beats in `projects/ena-promo-ai/04_plan/edit_blueprint.yaml:10`.
- Current timeline: V1 has 19 clips; V2/A1/A2/A3 are empty in `projects/ena-promo-ai/05_timeline/timeline.json:14`.
- Visible content sum: 1407 frames / 58.625s.
- Timeline span: first clip starts at frame 216; last clip ends at frame 1974 / 82.25s.
- Missing content: 753 frames / 31.375s.
- The timeline provenance only persists `duration_policy`, not a full duration or beat-fill diagnostic: `projects/ena-promo-ai/05_timeline/timeline.json:1137`.

The current `compile-timeline.log` should not be used as evidence for this artifact set. It is dated June 17 while the blueprint/selects/timeline files are dated June 19, and it reports a different timeline shape (`total_frames: 6230`, `target_frames: 5520`) at `projects/ena-promo-ai/compile-timeline.log:13`.

## Beat-by-beat breakdown

| Beat | Target | Blueprint role requirement | Candidate plan | Candidate existence / eligibility | Timeline allocation | Result |
| --- | ---: | --- | --- | --- | ---: | --- |
| b01_hook | 216f / 9.0s | `required_roles: hero`; `preferred_roles: support, texture` at `edit_blueprint.yaml:11` | primary `cand_x9_g0Kny8qFa`, no fallbacks at `edit_blueprint.yaml:27` | Exists as support, eligible for b01 at `selects_candidates.yaml:4` and `selects_candidates.yaml:23` | 0f | Empty. Shared candidate is reserved for b05 by reverse reservation; no hero candidates exist. |
| b02_discovery | 540f / 22.5s | support required at `edit_blueprint.yaml:30` | primary + 11 fallbacks at `edit_blueprint.yaml:45` | All refs exist. `cand_YAnpFys2AQxM` is duplicated in selects with different eligible beats. | 540f | Fully filled by CLP_0001..CLP_0006, frames 216-756. |
| b03_connection | 540f / 22.5s | support required at `edit_blueprint.yaml:59` | primary + 6 fallbacks at `edit_blueprint.yaml:74` | All refs exist and are eligible for b03. | 343f | Underfilled by 197f. CLP_0009 shrank from its assembled 317f slot to 120f, leaving frame gap 1008-1205. |
| b04_serenity | 540f / 22.5s | support required, texture preferred at `edit_blueprint.yaml:83` | primary + 27 fallbacks at `edit_blueprint.yaml:98` | All refs exist; 4 fallback refs are eligible for b02, not b04. Planned refs bypass eligibility filtering. | 386f | Underfilled by 154f. Adaptive trim shrank selected clips and left gaps 1526-1649, 1685-1696, and 1816-1836. |
| b05_closing | 324f / 13.5s | support required, texture preferred at `edit_blueprint.yaml:128` | primary `cand_x9_g0Kny8qFa` + 28 fallbacks at `edit_blueprint.yaml:144` | All refs exist; almost all are eligible for b01, b02, or b04 rather than b05, but planned refs bypass the eligibility filter. | 138f | Underfilled by 186f. CLP_0019 shrank from its assembled 306f slot to 120f, leaving the final 1974-2160 tail empty. |

Deficit by beat:

| Beat | Target frames | Actual content frames | Missing frames | Missing seconds |
| --- | ---: | ---: | ---: | ---: |
| b01_hook | 216 | 0 | 216 | 9.000 |
| b02_discovery | 540 | 540 | 0 | 0.000 |
| b03_connection | 540 | 343 | 197 | 8.208 |
| b04_serenity | 540 | 386 | 154 | 6.417 |
| b05_closing | 324 | 138 | 186 | 7.750 |
| Total | 2160 | 1407 | 753 | 31.375 |

## Gap analysis

The gaps map exactly to missing beat budget:

| Gap | Frames | Seconds | Cause |
| --- | ---: | ---: | --- |
| 0-216 | 216 | 9.000 | b01 marker exists, but no b01 clip was placed. First clip starts at frame 216 in `timeline.json:26`. |
| 1008-1205 | 197 | 8.208 | b03 CLP_0009 ends at 1008 after trim; CLP_0010 still starts at 1205 (`timeline.json:355` and `timeline.json:394`). |
| 1526-1649 | 123 | 5.125 | b04 CLP_0015 ends at 1526 after trim; CLP_0016 still starts at 1649 (`timeline.json:631` and `timeline.json:671`). |
| 1685-1696 | 11 | 0.458 | b04 CLP_0016 ends at 1685; CLP_0017 still starts at 1696 (`timeline.json:671` and `timeline.json:711`). |
| 1816-1836 | 20 | 0.833 | b04 CLP_0017 ends at 1816; b05 starts at marker/frame 1836 (`timeline.json:711` and `timeline.json:750`). |
| 1974-2160 | 186 | 7.750 | b05 CLP_0019 ends at frame 1974; target beat window ends at 2160 (`timeline.json:790`). |

This is not a transition overlap math issue. Transitions record `snap_delta_frames: 0`, including the gap-adjacent transitions around CLP_0015/CLP_0016 and CLP_0017/CLP_0018 at `timeline.json:1080` and `timeline.json:1106`. The gap already exists in clip start/end geometry.

## Duration shortfall root cause

Assembly initially fills the post-hook beat windows. In an in-memory replay of the compiler phases against the current artifacts:

- After assembly: 19 clips, 1944 content frames, first clip at 216, last end at 2160, no internal gaps. b01 is already empty.
- After adaptive trim: 19 clips, 1407 content frames, last end at 1974, and the exact gaps listed above.

The shrink happens because `applyAdaptiveTrim()` mutates `timeline_duration_frames` down to the resolved source trim length only when the new duration is shorter, but does not move later clips (`runtime/compiler/trim.ts:553`). The trim phase is called after assembly in `runtime/compiler/index.ts:686`.

Guide-mode duration adjustment then returns without doing recovery because it only adjusts strict mode (`runtime/compiler/duration-adjust.ts:23`). The guide-mode global fill pass also does not run for this project because it is guarded by `layout === "multi"` (`runtime/compiler/assemble.ts:390`), while the blueprint has `track_layout: single` at `edit_blueprint.yaml:226`.

Duration diagnostics do not catch the real user-visible shortfall because `resolve()` measures only the maximum video end frame (`runtime/compiler/resolve.ts:164`) and guide mode treats `duration_fit` as a max-bound check (`runtime/compiler/resolve.ts:206`). The current blueprint also sets `min_duration_sec: 1` and `max_duration_sec: 208.587775` (`edit_blueprint.yaml:216`), so a short 82.25s max-frame span can still report `duration_status: pass`.

## Role mismatch root cause

Selects contain no hero candidates. Parsed role counts are:

- support: 39 rows
- texture: 10 rows
- hero: 0 rows

The first candidate, `cand_x9_g0Kny8qFa`, is support, not hero (`selects_candidates.yaml:4` and `selects_candidates.yaml:8`). The first texture candidates appear much later in the b04 pool, e.g. `cand_0NPONugKy2Fk` at `selects_candidates.yaml:659`.

The compiler does not require exact role equality with `required_roles`. It admits candidates whose role is either required or preferred (`runtime/compiler/score.ts:176`). Therefore b01's support/texture preferred roles allow support candidates to score even though hero is required. In single-track layout, visual candidates are then merged in hero -> support -> texture priority order (`runtime/compiler/assemble.ts:1008`), so support candidates are always considered before texture candidates.

For the persisted blueprint:

- b01 requires hero, but has no hero candidate and its support primary gets reserved for b05.
- b03 does not require hero; it requires support (`edit_blueprint.yaml:62`).
- b05 does not require texture; it requires support and only prefers texture (`edit_blueprint.yaml:131`).
- Texture candidates are not placed because support candidates fill the single V1 beat budgets first and the single-layout global fill pass does not exist.

So the all-support timeline is expected from the current persisted artifacts and current single-track role priority. It is not caused by exact-role matching dropping hero/texture beats. It is caused by missing hero material, texture being only preferred, support-first single-track selection, and no post-trim backfill.

## Candidate utilization

The selects artifact has 49 rows but only 46 unique `candidate_id` values. Duplicates are:

- `cand_YAnpFys2AQxM`
- `cand_Tf5O6oGgH1L7`
- `cand_jHoQbTlr3zdB`

The timeline uses 19 clips, all support, and uses no texture rows. If counted as available rows minus timeline clips, that is 30 candidate slots not used. If counted by candidate rows matching exact used source ranges, one duplicate row shares a used source, so 29 distinct rows are unplaced.

Unused candidates were generally not blocked by missing files or schema validation. Most were simply not reached because:

1. Assembly considered each beat filled before adaptive trim shortened clips.
2. Used source ranges are globally excluded by `usedClips` (`runtime/compiler/assemble.ts:77` and `runtime/compiler/assemble.ts:1124`).
3. Texture candidates are lower priority than support in single-layout V1 ordering (`runtime/compiler/assemble.ts:1008`).
4. The guide-mode fill pass that could use remaining candidates only runs in `multi` layout (`runtime/compiler/assemble.ts:390`).

Notable planned but unused rows include b03 fallbacks `cand_aERSmaIyJCx-` and `cand_MStO40bg3CtF`, plus all 10 texture candidates. They were available in the candidate pool, but not selected before the beat budget was considered filled.

## Specific code paths

1. BGM duration and reservation:
   - `edit_blueprint.yaml:189` provides `bgm_duration_sec: 208.587775`.
   - `runtime/compiler/index.ts:631` converts BGM duration to `maxDurationFrames`.
   - `runtime/compiler/assemble.ts:69` builds beat candidate reservations whenever `maxDurationFrames` exists.
   - `runtime/compiler/assemble.ts:776` only disables reservations when `maxDurationFrames == null`; it does not check whether the cap is actually below the beat total.
   - `runtime/compiler/assemble.ts:778` walks beats in reverse, so b05 can reserve shared `cand_x9_g0Kny8qFa` before b01.
   - `runtime/compiler/assemble.ts:801` filters candidates reserved for a different beat, leaving b01 empty.

2. Planned refs bypass beat eligibility:
   - `runtime/compiler/score.ts:116` resolves candidate-plan priority by `candidate_id` or `segment_id`.
   - `runtime/compiler/score.ts:167` skips the eligible-beat filter for planned candidates.
   - `runtime/compiler/score.ts:303` gives primary/fallback plan bonuses.
   - This is why b05 can use `cand_x9_g0Kny8qFa` even though that candidate's `eligible_beats` is b01.

3. Single-track assembly:
   - `runtime/compiler/assemble.ts:109` uses the single-track V1 placement loop.
   - `runtime/compiler/assemble.ts:118` keeps placing until the beat window is filled.
   - `runtime/compiler/assemble.ts:146` advances within the beat by the pre-trim `timeline_duration_frames`.
   - `runtime/compiler/assemble.ts:1174` clamps initial duration to remaining beat budget, trim hint, and source duration.

4. Adaptive trim gap creation:
   - `runtime/compiler/index.ts:696` plans Marlin/event trims after assembly.
   - `runtime/compiler/trim.ts:553` applies resolved source trims and shrinks clip duration.
   - `runtime/compiler/trim.ts:559` only lowers `timeline_duration_frames`; it does not retime downstream clips.
   - `runtime/agents/clip-trim-agent.ts:156` uses a 5s midpoint fallback for weak events, which explains several 120-frame post-trim clips.

5. No recovery:
   - `runtime/compiler/duration-adjust.ts:43` returns immediately when policy is not strict.
   - `runtime/compiler/assemble.ts:390` restricts guide-mode global fill to multi layout.
   - `runtime/compiler/resolve.ts:185` computes duration status from max frame bounds, not summed content or beat-fill coverage.
   - `scripts/compile-timeline.ts:129` prints resolution but does not persist beat-level fill diagnostics.

6. Micro-clip guard:
   - `runtime/compiler/index.ts:387` drops only clips below `MIN_RENDERABLE_FRAMES`.
   - `CLP_0018` is 18 frames at `timeline.json:750`, so it survives the 12-frame guard. Its 0.75s duration is caused by b05 `ritardando` rhythm on a short planned clip; adaptive trim did not expand it back.

## Recommendations

1. Disable beat candidate reservations when the duration cap is not actually constraining the beat total. At minimum, only call `buildBeatCandidateReservations()` when `maxDurationFrames < totalBeatFrames`.
2. Do not let reverse reservations steal a beat's sole primary candidate. Shared candidate refs should either be reusable across non-overlapping beats or warned as a plan conflict before assembly.
3. After adaptive trim, compact V1 within each beat or rerun a fill pass using the final trimmed durations. This is the direct fix for the 197/123/11/20-frame internal gaps.
4. Add guide-mode underfill recovery for `track_layout: single`, not only `multi`.
5. Persist diagnostics in `timeline.json` or a compile report: content frames, max end frame, gap ranges, beat target vs actual, candidate shortages, role fill, and duration status.
6. Make role contracts explicit. If a beat requires hero or texture, warn/fail when selects contain none, and do not silently satisfy a required role with only preferred-role material.
7. Fix the current blueprint if the intended design is b01/b03 hero and b05 texture. The persisted file currently says b03 and b05 require support, not hero/texture.
8. Consider an advisory threshold above the renderability floor, e.g. warn for non-flash-cut clips below 24 frames. `CLP_0018` is technically renderable but editorially close to a micro-clip.
9. Clear or timestamp compile logs per run, or persist the current resolution object next to the timeline. The existing `compile-timeline.log` is stale and misleading for this investigation.
